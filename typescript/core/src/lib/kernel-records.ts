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

export type HashString = string;
export type EpochMs = number;
export type KernelRecord =
  | null
  | boolean
  | string
  | number
  | Uint8Array
  | KernelArray
  | KernelObject;
export type KernelArray = KernelRecord[];
export interface KernelObject {
  [key: string]: KernelRecord;
}

export function isHashString(value: unknown): value is HashString {
  return typeof value === "string" && HASH_STRING_PATTERN.test(value);
}

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

export function isEpochMs(value: unknown): value is EpochMs {
  return isCanonicalKernelInteger(value);
}

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

export function isKernelRecord(value: unknown): value is KernelRecord {
  return isKernelRecordValueInternal(value, new WeakSet<object>());
}

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
