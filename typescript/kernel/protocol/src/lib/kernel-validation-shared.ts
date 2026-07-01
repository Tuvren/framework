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

import type { KernelObject, KernelRecord } from "@tuvren/core";
import {
  assertEpochMs as assertSharedEpochMs,
  assertHashString as assertSharedHashString,
  assertKernelRecord as assertSharedKernelRecord,
  isEpochMs,
  isHashString,
  TuvrenValidationError,
} from "@tuvren/core";
import { decodeDeterministicKernelRecord } from "./kernel-identity.js";

export function isStringLiteral<const T extends readonly string[]>(
  value: unknown,
  literals: T
): value is T[number] {
  return typeof value === "string" && literals.includes(value);
}

export function tryAssert<T>(
  value: unknown,
  assertion: (value: unknown, label?: string) => asserts value is T
): value is T {
  try {
    assertion(value);
    return true;
  } catch {
    return false;
  }
}

export function validationError(
  message: string,
  code: string,
  details?: unknown
): TuvrenValidationError {
  return new TuvrenValidationError(message, {
    code,
    details,
  });
}

export function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw validationError(`${label} must be an array`, "invalid_array", {
      value,
    });
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw validationError(
      `${label} must be a dense data-only array`,
      "invalid_array",
      {
        value,
      }
    );
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
      throw validationError(
        `${label} must be a dense data-only array`,
        "invalid_array",
        { value }
      );
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw validationError(
        `${label} must be a dense data-only array`,
        "invalid_array",
        { value }
      );
    }
  }

  return value;
}

export function assertPlainObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`${label} must be a plain object`, "invalid_object", {
      value,
    });
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(`${label} must be a plain object`, "invalid_object", {
      value,
    });
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw validationError(`${label} must be a plain object`, "invalid_object", {
      value,
    });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];

    if (
      !(descriptor?.enumerable && Object.hasOwn(descriptor, "value")) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw validationError(
        `${label} must be a plain object`,
        "invalid_object",
        { value }
      );
    }
  }

  const normalizedObject: Record<string, unknown> = Object.create(null);

  for (const [entryKey, entryValue] of Object.entries(value)) {
    normalizedObject[entryKey] = entryValue;
  }

  return normalizedObject;
}

export function assertAllowedObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowedKeySet = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowedKeySet.has(key)) {
      throw validationError(
        `${label}.${key} is not part of the contract shape`,
        "invalid_object_key",
        { allowedKeys, key }
      );
    }
  }
}

export function assertOptionalFieldIsOmittedWhenUndefined(
  value: Record<string, unknown>,
  key: string,
  label: string
): void {
  if (Object.hasOwn(value, key) && value[key] === undefined) {
    throw validationError(
      `${label}.${key} must be omitted instead of undefined`,
      "invalid_optional_field",
      { key }
    );
  }
}

export function assertNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(
      `${label} must be a non-empty string`,
      "invalid_string",
      { value }
    );
  }
}

export function assertBoolean(
  value: unknown,
  label: string
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw validationError(`${label} must be a boolean`, "invalid_boolean", {
      value,
    });
  }
}

export function assertNullableHashString(
  value: unknown,
  label: string
): asserts value is string | null {
  if (value !== null) {
    assertHashString(value, label);
  }
}

export function assertNullableString(
  value: unknown,
  label: string
): asserts value is string | null {
  if (value !== null) {
    assertNonEmptyString(value, label);
  }
}

export function assertUint8Array(
  value: unknown,
  label: string
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw validationError(
      `${label} must be a Uint8Array`,
      "invalid_uint8_array",
      { value }
    );
  }
}

export function assertNonNegativeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!isEpochMs(value)) {
    throw validationError(
      `${label} must be a non-negative safe integer`,
      "invalid_integer",
      { value }
    );
  }

  const integerValue: number = value;

  if (integerValue < 0) {
    throw validationError(
      `${label} must be a non-negative safe integer`,
      "invalid_integer",
      { value: integerValue }
    );
  }
}

export function assertHashString(
  value: unknown,
  label: string
): asserts value is string {
  try {
    assertSharedHashString(value, label);
  } catch (error: unknown) {
    throw validationError(
      error instanceof Error
        ? error.message
        : `${label} must be a lowercase 64-character SHA-256 hex digest`,
      "invalid_hash_string",
      { value }
    );
  }
}

export function assertEpochMs(
  value: unknown,
  label: string
): asserts value is number {
  try {
    assertSharedEpochMs(value, label);
  } catch (error: unknown) {
    throw validationError(
      error instanceof Error
        ? error.message
        : `${label} must be a non-negative safe integer epoch milliseconds value`,
      "invalid_epoch_ms",
      { value }
    );
  }
}

export function assertKernelRecord(
  value: unknown,
  label = "value"
): asserts value is KernelRecord {
  try {
    assertSharedKernelRecord(value, label);
  } catch (error: unknown) {
    throw validationError(
      error instanceof Error
        ? error.message
        : `${label} must match the restricted runtime kernel record profile`,
      "invalid_kernel_record",
      { value }
    );
  }
}

export function assertKernelRecordArray(
  value: unknown,
  label: string
): asserts value is KernelRecord[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertKernelRecord(item, `${label}[${index}]`);
  }
}

export function assertKernelObject(
  value: unknown,
  label: string
): asserts value is KernelObject {
  assertPlainObject(value, label);
  assertKernelRecord(value, label);
}

export function assertKernelObjectArray(
  value: unknown,
  label: string
): asserts value is KernelObject[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertKernelObject(item, `${label}[${index}]`);
  }
}

export function isHashStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }

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
    if (!(Object.hasOwn(value, index) && isHashString(value[index]))) {
      return false;
    }
  }

  return true;
}

export function assertHashStringArray(
  value: unknown,
  label: string
): asserts value is string[] {
  const items = assertArray(value, label);

  for (const [index, item] of items.entries()) {
    assertHashString(item, `${label}[${index}]`);
  }
}

export function assertDecodedKernelRecord<T>(
  value: Uint8Array,
  assertion: (value: unknown, label: string) => asserts value is T,
  label: string
): T {
  let decodedValue: KernelRecord;

  try {
    decodedValue = decodeDeterministicKernelRecord(value);
  } catch (error: unknown) {
    throw validationError(
      `${label} must contain canonical deterministic CBOR`,
      "invalid_cbor_payload",
      {
        cause:
          error instanceof Error
            ? error.message
            : "unknown CBOR decode failure",
      }
    );
  }

  assertion(decodedValue, label);

  return decodedValue;
}

export function assertDecodedHashStringArray(
  value: Uint8Array,
  label: string
): string[] {
  return assertDecodedKernelRecord(value, assertHashStringArray, label);
}

export function assertDecodedHashStringArrayCardinality(
  value: Uint8Array,
  expectedCount: number,
  payloadLabel: string,
  countLabel: string
): void {
  const decodedItems = assertDecodedHashStringArray(value, payloadLabel);

  if (decodedItems.length !== expectedCount) {
    throw validationError(
      `${countLabel} must match the decoded item count in ${payloadLabel}`,
      "invalid_cbor_item_count",
      { actualCount: decodedItems.length, expectedCount }
    );
  }
}
