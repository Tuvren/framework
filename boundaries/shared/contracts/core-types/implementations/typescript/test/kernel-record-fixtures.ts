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

import type { KernelRecord } from "@tuvren/core-types";
import { assertKernelRecord } from "@tuvren/core-types";
import { Encoder } from "cbor-x";

// Binding-local probes only: shared core-types authority lives in the packet
// TypeSpec and generated schemas, not in these TypeScript test values.
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

export const deterministicKernelRecordFixture = {
  logicalValue: {
    active: true,
    bytes: new Uint8Array([1, 2, 3, 4]),
    items: ["alpha", 7, null],
    meta: {
      count: 2,
      label: "kraken",
    },
    timestamp: 1_717_171_717_171,
  } satisfies KernelRecord,
  expectedCborHex:
    "a5646d657461a265636f756e7402656c6162656c666b72616b656e6562797465734401020304656974656d738365616c70686107f666616374697665f56974696d657374616d701b0000018fcf690433",
  expectedSha256Hex:
    "a7e74da5ec721eb03b261d9898f0ade2a6e26ba63d123ca94669d6b130d38a98",
};

export const kernelRecordInsertionOrderVariants: readonly KernelRecord[] = [
  {
    timestamp: 1_717_171_717_171,
    meta: {
      label: "kraken",
      count: 2,
    },
    items: ["alpha", 7, null],
    bytes: new Uint8Array([1, 2, 3, 4]),
    active: true,
  },
  {
    active: true,
    bytes: new Uint8Array([1, 2, 3, 4]),
    items: ["alpha", 7, null],
    meta: {
      count: 2,
      label: "kraken",
    },
    timestamp: 1_717_171_717_171,
  },
];

export const invalidKernelRecordFixtures: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  3.14,
  BigInt(7),
  new Date("2026-01-01T00:00:00.000Z"),
  new Map([["a", 1]]),
  new Set([1]),
  undefined,
  () => "nope",
];

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
    compareKeys(leftKey, rightKey)
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

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  let digestInput: ArrayBuffer;

  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    digestInput = bytes.buffer;
  } else if (bytes.buffer instanceof ArrayBuffer) {
    digestInput = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
  } else {
    digestInput = Uint8Array.from(bytes).buffer;
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
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

function compareKeys(leftKey: string, rightKey: string): number {
  return compareByteArrays(
    encodeDeterministicScalar(leftKey),
    encodeDeterministicScalar(rightKey)
  );
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

function encodeDeterministicScalar(value: string): Uint8Array {
  return new Uint8Array(deterministicScalarEncoder.encode(value));
}
