/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { HashString, KernelRecord } from "@tuvren/core";
import {
  assertHashString,
  assertKernelRecord,
  TuvrenValidationError,
} from "@tuvren/core";
import { Decoder, Encoder } from "cbor-x";

/**
 * cbor-x options pinned for deterministic output: no Uint8Array tagging, no
 * map tag 259, no record extensions, and length-accurate map headers.
 */
const deterministicEncoderOptions = {
  tagUint8Array: false,
  useTag259ForMaps: false,
  useRecords: false,
  variableMapSize: true,
};

const deterministicEncoder = new Encoder(deterministicEncoderOptions);

/**
 * Encoder used only to derive the byte order of map keys during
 * canonicalization.
 */
const deterministicScalarEncoder = new Encoder({
  tagUint8Array: false,
  useRecords: false,
  variableMapSize: true,
});

/**
 * Decoder that preserves CBOR maps as `Map`s so canonical re-encoding can be
 * verified byte-for-byte.
 */
const deterministicDecoder = new Decoder({
  mapsAsObjects: false,
  useRecords: false,
});

/**
 * Converts a KernelRecord into its canonical in-memory form ahead of
 * deterministic CBOR encoding.
 *
 * Scalars and `Uint8Array` values pass through unchanged, arrays are
 * canonicalized element-wise with order preserved, and plain objects become
 * `Map`s whose entries are sorted by the byte order of each key's deterministic
 * CBOR encoding. This key ordering is what makes two structurally equal records
 * encode to identical bytes regardless of property insertion order.
 *
 * @param value - Record to canonicalize.
 * @returns The canonical value tree (scalars, arrays, and key-sorted `Map`s).
 * @throws TuvrenValidationError When `value` is not a valid KernelRecord.
 */
export function canonicalizeKernelRecord(value: KernelRecord): unknown {
  assertKernelRecord(value);

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeKernelRecord(item));
  }

  const sortedEntries = Object.entries(value).sort(([leftKey], [rightKey]) =>
    compareByteArrays(
      encodeDeterministicScalar(leftKey),
      encodeDeterministicScalar(rightKey)
    )
  );

  return new Map(
    sortedEntries.map(([key, nestedValue]) => [
      key,
      canonicalizeKernelRecord(nestedValue),
    ])
  );
}

/**
 * Encodes a KernelRecord to canonical deterministic CBOR bytes.
 *
 * The record is first canonicalized (see {@link canonicalizeKernelRecord});
 * integers outside the 32-bit range are then widened to `BigInt` so the encoder
 * emits the canonical CBOR integer form rather than a float64. Identical records
 * always produce identical bytes — the foundation of kernel content addressing
 * (docs/KrakenKernelSpecification.md §2.3). Committed cross-language vectors for
 * this encoding live in
 * spec/conformance/kernel/fixtures/kernel-protocol-deterministic.json; per the
 * repository conformance policy, those committed fixtures are the authority and
 * this implementation is the reference generator.
 *
 * @throws TuvrenValidationError When `value` is not a valid KernelRecord.
 */
export function encodeDeterministicKernelRecord(
  value: KernelRecord
): Uint8Array {
  const canonicalValue = canonicalizeKernelRecord(value);
  return new Uint8Array(
    deterministicEncoder.encode(prepareCanonicalKernelValue(canonicalValue))
  );
}

/**
 * Decodes canonical deterministic CBOR bytes back into a KernelRecord.
 *
 * Strict inverse of {@link encodeDeterministicKernelRecord}: the decoded value
 * is normalized (CBOR maps to plain objects, bigints back to safe integers,
 * byte strings copied) and then re-encoded; if the re-encoded bytes do not equal
 * the input byte-for-byte, the call rejects. This guarantees a record accepted
 * by the kernel has exactly one durable identity — non-canonical encodings of
 * the same logical record are refused rather than silently rehashed.
 *
 * @param bytes - Candidate canonical deterministic CBOR bytes.
 * @returns The decoded KernelRecord.
 * @throws TuvrenValidationError With code `invalid_decoded_kernel_record` when
 *   the bytes are not valid CBOR or decode to unsupported values (non-string map
 *   keys, out-of-range bigints, non-canonical numbers), or
 *   `non_canonical_kernel_record_encoding` when the bytes are valid CBOR but not
 *   the canonical encoding.
 */
export function decodeDeterministicKernelRecord(
  bytes: Uint8Array
): KernelRecord {
  let decodedValue: unknown;

  try {
    decodedValue = deterministicDecoder.decode(bytes);
  } catch (error: unknown) {
    throw new TuvrenValidationError(
      "decoded kernel record bytes must contain valid deterministic CBOR",
      {
        code: "invalid_decoded_kernel_record",
        details: {
          cause:
            error instanceof Error
              ? error.message
              : "unknown CBOR decode failure",
        },
      }
    );
  }

  const normalizedValue = normalizeDecodedKernelValue(decodedValue, "value");
  const canonicalBytes = encodeDeterministicKernelRecord(normalizedValue);

  assertKernelRecord(normalizedValue, "decoded kernel record");

  if (!areByteArraysEqual(bytes, canonicalBytes)) {
    throw new TuvrenValidationError(
      "decoded kernel record must already use the canonical deterministic CBOR encoding",
      {
        code: "non_canonical_kernel_record_encoding",
        details: {
          canonicalHex: bytesToHex(canonicalBytes),
          receivedHex: bytesToHex(bytes),
        },
      }
    );
  }

  return normalizedValue;
}

/**
 * Computes the content-address of a KernelRecord: the lowercase hex SHA-256
 * digest of its canonical deterministic CBOR encoding
 * (docs/KrakenKernelSpecification.md §2.3).
 *
 * Identical records always hash identically. TurnTree and TurnNode identity
 * (see `hashTurnTreeIdentity` / `hashTurnNodeIdentity` in kernel-identity.ts)
 * both derive from this digest.
 */
export function hashKernelRecord(value: KernelRecord): Promise<HashString> {
  return hashBytesToHex(encodeDeterministicKernelRecord(value));
}

/**
 * Computes the content-address of an opaque Object blob: the lowercase hex
 * SHA-256 digest of the raw bytes, with no CBOR canonicalization (kernel spec
 * §2.1–§2.3). Used for raw blobs, where the bytes themselves are the canonical
 * representation.
 */
export function hashOpaqueObjectBytes(bytes: Uint8Array): Promise<HashString> {
  return hashBytesToHex(bytes);
}

/**
 * Widens integers outside the 32-bit range to `BigInt` (recursively through
 * arrays and maps) so cbor-x encodes them as CBOR integers instead of float64.
 */
function prepareCanonicalKernelValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (value > 0xff_ff_ff_ff || value < -0x1_00_00_00_00) {
      return BigInt(value);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => prepareCanonicalKernelValue(item));
  }

  if (value instanceof Map) {
    return new Map(
      Array.from(value, ([key, nestedValue]) => [
        key,
        prepareCanonicalKernelValue(nestedValue),
      ])
    );
  }

  return value;
}

/**
 * Normalizes a decoded CBOR value back into KernelRecord form: `Map`s become
 * null-prototype plain objects with string keys, bigints collapse to safe
 * integers, and byte strings are copied. Rejects anything outside the kernel
 * record value domain.
 */
function normalizeDecodedKernelValue(
  value: unknown,
  label: string
): KernelRecord {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return normalizeDecodedKernelNumber(value, label);
  }

  if (typeof value === "bigint") {
    const normalizedInteger = Number(value);

    if (!Number.isSafeInteger(normalizedInteger)) {
      throw new TuvrenValidationError(
        `${label} decoded to an out-of-range bigint value`,
        {
          code: "invalid_decoded_kernel_record",
          details: { value: value.toString() },
        }
      );
    }

    return normalizedInteger;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeDecodedKernelValue(item, `${label}[${index}]`)
    );
  }

  if (value instanceof Map) {
    const objectValue = Object.create(null) as Record<string, KernelRecord>;

    for (const [entryKey, entryValue] of value) {
      if (typeof entryKey !== "string") {
        throw new TuvrenValidationError(
          `${label} contains a non-string map key after CBOR decode`,
          {
            code: "invalid_decoded_kernel_record",
            details: { entryKey },
          }
        );
      }

      objectValue[entryKey] = normalizeDecodedKernelValue(
        entryValue,
        `${label}.${entryKey}`
      );
    }

    return objectValue;
  }

  if (typeof value !== "object") {
    throw new TuvrenValidationError(
      `${label} decoded to an unsupported kernel record type`,
      {
        code: "invalid_decoded_kernel_record",
        details: { decodedType: typeof value },
      }
    );
  }

  if (isPlainObject(value)) {
    const objectValue = Object.create(null) as Record<string, KernelRecord>;

    for (const [entryKey, entryValue] of Object.entries(value)) {
      objectValue[entryKey] = normalizeDecodedKernelValue(
        entryValue,
        `${label}.${entryKey}`
      );
    }

    return objectValue;
  }

  throw new TuvrenValidationError(
    `${label} decoded to an unsupported kernel record type`,
    {
      code: "invalid_decoded_kernel_record",
      details: {
        decodedType:
          value == null ? value : Object.prototype.toString.call(value),
      },
    }
  );
}

/**
 * Rejects numbers that have no canonical kernel encoding: non-integers,
 * unsafe integers, NaN, infinities, and negative zero.
 */
function normalizeDecodedKernelNumber(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number.isNaN(value) ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    throw new TuvrenValidationError(
      `${label} decoded to a non-canonical kernel number`,
      {
        code: "invalid_decoded_kernel_record",
        details: { value },
      }
    );
  }

  return value;
}

/**
 * True for objects whose prototype is `Object.prototype` or `null`.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Encodes a map key for canonical byte-order comparison.
 */
function encodeDeterministicScalar(value: string): Uint8Array {
  return new Uint8Array(deterministicScalarEncoder.encode(value));
}

/**
 * Lexicographic byte comparison; shorter prefix sorts first on ties.
 */
function compareByteArrays(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array
): number {
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }

  if (leftBytes.length === rightBytes.length) {
    return 0;
  }

  return leftBytes.length < rightBytes.length ? -1 : 1;
}

/**
 * Byte-for-byte equality used by the canonical re-encoding check.
 */
function areByteArraysEqual(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array
): boolean {
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Lowercase hex rendering used in validation error details.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/**
 * SHA-256 via WebCrypto, rendered as lowercase hex and validated as a
 * HashString.
 */
async function hashBytesToHex(bytes: Uint8Array): Promise<HashString> {
  const digestInput = getDigestInput(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  assertHashString(hash, "hash");
  return hash;
}

/**
 * Produces a digest input that covers exactly the view's bytes, copying when the
 * view does not span its whole ArrayBuffer (or is backed by a SharedArrayBuffer).
 */
function getDigestInput(bytes: Uint8Array): BufferSource {
  const { buffer, byteLength, byteOffset } = bytes;

  if (!(buffer instanceof ArrayBuffer)) {
    return Uint8Array.from(bytes);
  }

  if (byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer;
  }

  return buffer.slice(byteOffset, byteOffset + byteLength);
}
