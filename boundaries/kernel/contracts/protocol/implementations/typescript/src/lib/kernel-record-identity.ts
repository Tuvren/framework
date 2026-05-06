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

import type { HashString, KernelRecord } from "@tuvren/core-types";
import {
  assertHashString,
  assertKernelRecord,
  TuvrenValidationError,
} from "@tuvren/core-types";
import { Decoder, Encoder } from "cbor-x";

const deterministicEncoderOptions = {
  tagUint8Array: false,
  useTag259ForMaps: false,
  useRecords: false,
  variableMapSize: true,
};

const deterministicEncoder = new Encoder(deterministicEncoderOptions);

const deterministicScalarEncoder = new Encoder({
  tagUint8Array: false,
  useRecords: false,
  variableMapSize: true,
});

const deterministicDecoder = new Decoder({
  mapsAsObjects: false,
  useRecords: false,
});

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

export function encodeDeterministicKernelRecord(
  value: KernelRecord
): Uint8Array {
  const canonicalValue = canonicalizeKernelRecord(value);
  return new Uint8Array(
    deterministicEncoder.encode(prepareCanonicalKernelValue(canonicalValue))
  );
}

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

export function hashKernelRecord(value: KernelRecord): Promise<HashString> {
  return hashBytesToHex(encodeDeterministicKernelRecord(value));
}

export function hashOpaqueObjectBytes(bytes: Uint8Array): Promise<HashString> {
  return hashBytesToHex(bytes);
}

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

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeDeterministicScalar(value: string): Uint8Array {
  return new Uint8Array(deterministicScalarEncoder.encode(value));
}

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

async function hashBytesToHex(bytes: Uint8Array): Promise<HashString> {
  const digestInput = getDigestInput(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  assertHashString(hash, "hash");
  return hash;
}

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
