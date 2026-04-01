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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { HashString, KernelRecord } from "@kraken/shared-core-types";
import {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  KrakenValidationError,
} from "@kraken/shared-core-types";
import { Decoder, Encoder } from "cbor-x";
import type {
  StagedResult,
  TurnNode,
  TurnTreeManifest,
} from "./kernel-types.js";

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
const STAGED_RESULT_STATUSES = ["completed", "failed", "interrupted"] as const;

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
    throw new KrakenValidationError(
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
    throw new KrakenValidationError(
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

export function hashTurnTreeIdentity(
  schemaId: string,
  manifest: TurnTreeManifest
): Promise<HashString> {
  assertNonEmptyString(schemaId, "schemaId");
  assertKernelRecord(manifest, "manifest");
  return hashKernelRecord({ manifest, schemaId });
}

export async function hashTurnNodeIdentity(
  value: Omit<TurnNode, "hash"> | TurnNode
): Promise<HashString> {
  const turnNodeValue = assertTurnNodeIdentityInput(value);
  return await hashKernelRecord(toTurnNodeIdentityRecord(turnNodeValue));
}

function toTurnNodeIdentityRecord(
  value: Omit<TurnNode, "hash"> | TurnNode
): KernelRecord {
  const turnNodeValue = value as TurnNode & {
    hash?: HashString;
  };
  const identityRecord = {
    consumedStagedResults: turnNodeValue.consumedStagedResults.map(
      (stagedResult) => {
        const projectedResult = {
          objectHash: stagedResult.objectHash,
          objectType: stagedResult.objectType,
          status: stagedResult.status,
          taskId: stagedResult.taskId,
          timestamp: stagedResult.timestamp,
        } as {
          interruptPayload?: KernelRecord;
          objectHash: HashString;
          objectType: string;
          status: typeof stagedResult.status;
          taskId: string;
          timestamp: number;
        };

        if (stagedResult.interruptPayload !== undefined) {
          projectedResult.interruptPayload = stagedResult.interruptPayload;
        }

        return projectedResult;
      }
    ),
    eventHash: turnNodeValue.eventHash,
    previousTurnNodeHash: turnNodeValue.previousTurnNodeHash,
    schemaId: turnNodeValue.schemaId,
    turnTreeHash: turnNodeValue.turnTreeHash,
  } satisfies KernelRecord;

  assertKernelRecord(identityRecord, "turn node identity payload");

  return identityRecord;
}

function assertTurnNodeIdentityInput(
  value: Omit<TurnNode, "hash"> | TurnNode
): Omit<TurnNode, "hash"> | TurnNode {
  const objectValue = assertPlainObjectRecord(
    value,
    "turn node identity input"
  );

  assertAllowedKeys(
    objectValue,
    [
      "consumedStagedResults",
      "eventHash",
      "hash",
      "previousTurnNodeHash",
      "schemaId",
      "turnTreeHash",
    ],
    "turn node identity input"
  );

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "hash",
    "turn node identity input"
  );

  if (Object.hasOwn(objectValue, "hash")) {
    assertHashStringOrThrow(objectValue.hash, "turn node identity input.hash");
  }

  assertNullableHashStringOrThrow(
    objectValue.eventHash,
    "turn node identity input.eventHash"
  );
  assertNullableHashStringOrThrow(
    objectValue.previousTurnNodeHash,
    "turn node identity input.previousTurnNodeHash"
  );
  assertHashStringOrThrow(
    objectValue.turnTreeHash,
    "turn node identity input.turnTreeHash"
  );
  assertNonEmptyString(
    objectValue.schemaId,
    "turn node identity input.schemaId"
  );

  const consumedStagedResults = objectValue.consumedStagedResults;

  if (!Array.isArray(consumedStagedResults)) {
    throw new KrakenValidationError(
      "turn node identity input must include consumedStagedResults as an array",
      {
        code: "invalid_turn_node_hash",
        details: { value: objectValue },
      }
    );
  }

  const normalizedConsumedStagedResults = consumedStagedResults.map(
    (stagedResult, index) =>
      assertStagedResultIdentityInput(
        stagedResult,
        `turn node identity input.consumedStagedResults[${index}]`
      )
  );

  return Object.assign(Object.create(null), objectValue, {
    consumedStagedResults: normalizedConsumedStagedResults,
  }) as Omit<TurnNode, "hash"> | TurnNode;
}

function assertStagedResultIdentityInput(
  value: unknown,
  label: string
): StagedResult {
  const objectValue = assertPlainObjectRecord(value, label);

  assertAllowedKeys(
    objectValue,
    [
      "interruptPayload",
      "objectHash",
      "objectType",
      "status",
      "taskId",
      "timestamp",
    ],
    label
  );

  assertOptionalFieldIsOmittedWhenUndefined(
    objectValue,
    "interruptPayload",
    label
  );
  assertHashStringOrThrow(objectValue.objectHash, `${label}.objectHash`);
  assertNonEmptyString(objectValue.objectType, `${label}.objectType`);
  assertStagedResultStatusOrThrow(objectValue.status, `${label}.status`);
  assertNonEmptyString(objectValue.taskId, `${label}.taskId`);
  assertEpochMs(objectValue.timestamp, `${label}.timestamp`);

  if (objectValue.interruptPayload !== undefined) {
    assertKernelRecord(
      objectValue.interruptPayload,
      `${label}.interruptPayload`
    );
  }

  const normalizedValue = {
    objectHash: objectValue.objectHash as HashString,
    objectType: objectValue.objectType as string,
    status: objectValue.status as StagedResult["status"],
    taskId: objectValue.taskId as string,
    timestamp: objectValue.timestamp as StagedResult["timestamp"],
  } as {
    interruptPayload?: KernelRecord;
    objectHash: HashString;
    objectType: string;
    status: StagedResult["status"];
    taskId: string;
    timestamp: StagedResult["timestamp"];
  };

  if (objectValue.interruptPayload !== undefined) {
    normalizedValue.interruptPayload =
      objectValue.interruptPayload as KernelRecord;
  }

  return normalizedValue;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowedKeySet = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowedKeySet.has(key)) {
      throw turnNodeIdentityError(
        `${label}.${key} is not part of the contract shape`,
        {
          allowedKeys,
          key,
        }
      );
    }
  }
}

function assertPlainObjectRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw turnNodeIdentityError(`${label} must be a plain object`, { value });
  }

  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw turnNodeIdentityError(`${label} must be a plain object`, { value });
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);

  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key];

    if (
      !(descriptor?.enumerable && Object.hasOwn(descriptor, "value")) ||
      Object.hasOwn(descriptor, "get") ||
      Object.hasOwn(descriptor, "set")
    ) {
      throw turnNodeIdentityError(`${label} must be a plain object`, { value });
    }
  }

  return Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(value))
  ) as Record<string, unknown>;
}

function assertOptionalFieldIsOmittedWhenUndefined(
  value: Record<string, unknown>,
  key: string,
  label: string
): void {
  if (Object.hasOwn(value, key) && value[key] === undefined) {
    throw turnNodeIdentityError(
      `${label}.${key} must be omitted instead of undefined`,
      { key }
    );
  }
}

function assertHashStringOrThrow(value: unknown, label: string): void {
  try {
    assertHashString(value, label);
  } catch (error: unknown) {
    throw turnNodeIdentityError(
      error instanceof Error ? error.message : `${label} must be a hash string`,
      { value }
    );
  }
}

function assertNullableHashStringOrThrow(value: unknown, label: string): void {
  if (value === null) {
    return;
  }

  assertHashStringOrThrow(value, label);
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw turnNodeIdentityError(`${label} must be a non-empty string`, {
      value,
    });
  }
}

function assertStagedResultStatusOrThrow(value: unknown, label: string): void {
  if (
    !(
      typeof value === "string" &&
      (STAGED_RESULT_STATUSES as readonly string[]).includes(value)
    )
  ) {
    throw turnNodeIdentityError(
      `${label} must be one of ${STAGED_RESULT_STATUSES.join(", ")}`,
      { value }
    );
  }
}

function turnNodeIdentityError(
  message: string,
  details: unknown
): KrakenValidationError {
  return new KrakenValidationError(message, {
    code: "invalid_turn_node_hash",
    details,
  });
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
      throw new KrakenValidationError(
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
        throw new KrakenValidationError(
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
    throw new KrakenValidationError(
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

  throw new KrakenValidationError(
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
    throw new KrakenValidationError(
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
