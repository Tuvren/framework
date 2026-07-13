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

const HASH_STRING_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A kernel content address: the lowercase 64-character hex encoding of a
 * SHA-256 digest. Hashes identify write-once durable Objects
 * (KrakenKernelSpecification §2.1, §2.3); identical canonical blobs produce
 * identical hashes.
 */
export type HashString = string;

/**
 * A Unix-epoch timestamp in milliseconds, restricted to the canonical
 * kernel integer profile: a safe integer that is never `-0`.
 */
export type EpochMs = number;

/**
 * The restricted value profile allowed to cross the kernel boundary and be
 * durably stored: `null`, booleans, strings, canonical integers (safe
 * integers, never `-0` — fractional numbers are excluded), `Uint8Array`
 * byte payloads, and acyclic dense arrays / plain objects thereof.
 *
 * The profile is deliberately narrower than JSON so every record has a
 * canonical blob encoding and therefore a stable content-address hash
 * (KrakenKernelSpecification §2.2–2.3).
 */
export type KernelRecord =
  | null
  | boolean
  | string
  | number
  | Uint8Array
  | KernelArray
  | KernelObject;

/** An array of {@link KernelRecord} values (dense, no holes when validated). */
export type KernelArray = KernelRecord[];

/** A plain string-keyed object whose values are all {@link KernelRecord}s. */
export interface KernelObject {
  [key: string]: KernelRecord;
}

/**
 * True when `value` is a canonical {@link HashString}: exactly 64 lowercase
 * hexadecimal characters (a SHA-256 digest). Uppercase or mixed-case hex is
 * rejected.
 */
export function isHashString(value: unknown): value is HashString {
  return typeof value === "string" && HASH_STRING_PATTERN.test(value);
}

/**
 * Asserts that `value` is a canonical {@link HashString}.
 *
 * @param value - Untrusted candidate hash.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TypeError when {@link isHashString} rejects the value.
 */
export function assertHashString(
  value: unknown,
  label = "value"
): asserts value is HashString {
  if (!isHashString(value)) {
    throw new TypeError(
      `${label} must be a lowercase 64-character SHA-256 hex digest`
    );
  }
}

/**
 * True when `value` is a canonical {@link EpochMs}: a safe integer that is
 * not `-0`. Fractional or non-finite numbers are rejected.
 */
export function isEpochMs(value: unknown): value is EpochMs {
  return isCanonicalKernelInteger(value);
}

/**
 * Asserts that `value` is a canonical {@link EpochMs} timestamp.
 *
 * @param value - Untrusted candidate timestamp.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws RangeError when {@link isEpochMs} rejects the value.
 */
export function assertEpochMs(
  value: unknown,
  label = "value"
): asserts value is EpochMs {
  if (!isEpochMs(value)) {
    throw new RangeError(
      `${label} must be a safe integer Unix epoch millisecond value`
    );
  }
}

/**
 * True when `value` matches the restricted {@link KernelRecord} profile,
 * checked recursively:
 *
 * - Numbers must be canonical kernel integers (safe integers, never `-0`);
 *   fractional numbers are rejected.
 * - Arrays must be dense (no holes), with only enumerable plain index
 *   properties and no symbol keys or accessors.
 * - Objects must be plain (`Object.prototype` or `null` prototype) with
 *   only enumerable data properties and no symbol keys.
 * - `Uint8Array` values must carry no extra own properties beyond their
 *   indices.
 * - Cyclic structures are rejected.
 *
 * These constraints guarantee the record has one canonical byte encoding,
 * which is what makes content-address hashing stable
 * (KrakenKernelSpecification §2.2–2.3).
 */
export function isKernelRecord(value: unknown): value is KernelRecord {
  return isKernelRecordValueInternal(value, new WeakSet<object>());
}

/**
 * Asserts that `value` matches the restricted {@link KernelRecord} profile.
 *
 * @param value - Untrusted candidate record.
 * @param label - Name used in the error message (defaults to `"value"`).
 * @throws TypeError when {@link isKernelRecord} rejects the value.
 */
export function assertKernelRecord(
  value: unknown,
  label = "value"
): asserts value is KernelRecord {
  if (!isKernelRecord(value)) {
    throw new TypeError(
      `${label} must match the restricted runtime kernel record profile`
    );
  }
}

function isKernelRecordValueInternal(
  value: unknown,
  activeParents: WeakSet<object>
): value is KernelRecord {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return isCanonicalKernelInteger(value);
    case "object":
      if (value instanceof Uint8Array) {
        return isCanonicalKernelBytes(value);
      }

      if (activeParents.has(value)) {
        return false;
      }

      activeParents.add(value);

      if (Array.isArray(value)) {
        const isValidArray = isDenseKernelArray(value, activeParents);
        activeParents.delete(value);
        return isValidArray;
      }

      if (!isPlainKernelObject(value)) {
        activeParents.delete(value);
        return false;
      }

      for (const key of Object.keys(value)) {
        if (!isKernelRecordValueInternal(value[key], activeParents)) {
          activeParents.delete(value);
          return false;
        }
      }

      activeParents.delete(value);
      return true;
    default:
      return false;
  }
}

function isPlainKernelObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];

    if (
      !(descriptor?.enumerable && Object.hasOwn(descriptor, "value")) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      return false;
    }
  }

  return true;
}

function isDenseKernelArray(
  value: unknown[],
  activeParents: WeakSet<object>
): value is KernelArray {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    if (key === "length") {
      continue;
    }

    const descriptor = descriptors[key];
    const index = Number(key);

    if (
      !(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key
      ) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      return false;
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (
      !(
        Object.hasOwn(value, index) &&
        isKernelRecordValueInternal(value[index], activeParents)
      )
    ) {
      return false;
    }
  }

  return true;
}

function isCanonicalKernelInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  );
}

function isCanonicalKernelBytes(value: Uint8Array): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];
    const index = Number(key);

    if (
      !(
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < value.length &&
        String(index) === key
      ) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      return false;
    }
  }

  return true;
}
