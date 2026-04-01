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

import { describe, expect, test } from "bun:test";

import {
  assertEpochMs,
  assertHashString,
  assertKernelRecord,
  isEpochMs,
  isHashString,
  isKernelRecord,
} from "@kraken/shared-core-types";
import {
  deterministicKernelRecordFixture,
  encodeDeterministicKernelRecord,
  invalidKernelRecordFixtures,
  kernelRecordInsertionOrderVariants,
  sha256Hex,
} from "../../../../../tests/fixtures/kernel-record-fixtures.js";

describe("HashString", () => {
  test("accepts lowercase 64-character hex digests", () => {
    expect(isHashString("a".repeat(64))).toBe(true);
    expect(() => assertHashString("f".repeat(64), "hash")).not.toThrow();
  });

  test("rejects malformed digests", () => {
    expect(isHashString("A".repeat(64))).toBe(false);
    expect(isHashString("abc123")).toBe(false);
    expect(isHashString("g".repeat(64))).toBe(false);
    expect(() => assertHashString("A".repeat(64), "hash")).toThrow(
      "hash must be a lowercase 64-character SHA-256 hex digest"
    );
  });
});

describe("EpochMs", () => {
  test("accepts safe integer epoch millisecond values", () => {
    expect(isEpochMs(1_717_171_717_171)).toBe(true);
    expect(() => assertEpochMs(-1, "epoch")).not.toThrow();
  });

  test("rejects non-integer or unsafe numbers", () => {
    expect(isEpochMs(1.5)).toBe(false);
    expect(isEpochMs(Number.NaN)).toBe(false);
    expect(isEpochMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isEpochMs(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(() => assertEpochMs(1.5, "epoch")).toThrow(
      "epoch must be a safe integer Unix epoch millisecond value"
    );
  });
});

describe("KernelRecord", () => {
  test("accepts the restricted kernel record profile", () => {
    expect(isKernelRecord(deterministicKernelRecordFixture.logicalValue)).toBe(
      true
    );
    expect(() =>
      assertKernelRecord(
        deterministicKernelRecordFixture.logicalValue,
        "record"
      )
    ).not.toThrow();
  });

  test("rejects unsupported runtime values", () => {
    for (const fixture of invalidKernelRecordFixtures) {
      expect(isKernelRecord(fixture)).toBe(false);
    }

    expect(() => assertKernelRecord(new Map([["a", 1]]), "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
  });

  test("rejects sparse arrays", () => {
    const sparseArray = new Array(3);
    sparseArray[0] = "alpha";
    sparseArray[2] = "omega";

    expect(isKernelRecord(sparseArray)).toBe(false);
    expect(() => assertKernelRecord(sparseArray, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
  });

  test("normalizes insertion-order variants to identical deterministic bytes", () => {
    const encodedVariants = kernelRecordInsertionOrderVariants.map((variant) =>
      Buffer.from(encodeDeterministicKernelRecord(variant)).toString("hex")
    );

    expect(new Set(encodedVariants).size).toBe(1);
  });

  test("locks the canonical fixture bytes and hash", async () => {
    const encodedBytes = encodeDeterministicKernelRecord(
      deterministicKernelRecordFixture.logicalValue
    );
    const encodedHex = Buffer.from(encodedBytes).toString("hex");
    const digestHex = await sha256Hex(encodedBytes);

    expect(encodedHex).toBe(deterministicKernelRecordFixture.expectedCborHex);
    expect(digestHex).toBe(deterministicKernelRecordFixture.expectedSha256Hex);
  });

  test("encodes large safe integers as CBOR integers instead of float64", () => {
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord({ timestamp: 1_717_171_717_171 })
    ).toString("hex");

    expect(encodedHex).toContain("1b");
    expect(encodedHex).not.toContain("fb4278fcf690433000");
  });
});
