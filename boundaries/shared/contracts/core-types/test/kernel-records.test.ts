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
  assertKrakenErrorCode,
  isEpochMs,
  isHashString,
  isKernelRecord,
  isKrakenErrorCode,
  KrakenPersistenceError,
  KrakenRuntimeError,
  KrakenValidationError,
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
    expect(isEpochMs(-0)).toBe(false);
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

  test("rejects inherited array elements from the prototype chain", () => {
    const inheritedArray = new Array(1);
    const originalPrototypeElement = Array.prototype[0];
    const hadOwnPrototypeElement = Object.hasOwn(Array.prototype, 0);

    Array.prototype[0] = "prototype-value";

    try {
      expect(isKernelRecord(inheritedArray)).toBe(false);
      expect(() => assertKernelRecord(inheritedArray, "record")).toThrow(
        "record must match the restricted Kraken kernel record profile"
      );
    } finally {
      if (hadOwnPrototypeElement) {
        Array.prototype[0] = originalPrototypeElement;
      } else {
        Reflect.deleteProperty(Array.prototype, 0);
      }
    }
  });

  test("rejects arrays with extra own metadata properties or symbols", () => {
    const hiddenPropertyArray = [1];
    Object.defineProperty(hiddenPropertyArray, "secret", {
      enumerable: false,
      value: 2,
    });

    const accessorArray = [1];
    Object.defineProperty(accessorArray, "extra", {
      enumerable: true,
      get() {
        return 2;
      },
    });

    const symbolArray = [1];
    symbolArray[Symbol("meta")] = 2;

    expect(isKernelRecord(hiddenPropertyArray)).toBe(false);
    expect(isKernelRecord(accessorArray)).toBe(false);
    expect(isKernelRecord(symbolArray)).toBe(false);
    expect(() => assertKernelRecord(hiddenPropertyArray, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
  });

  test("rejects objects with non-enumerable own string properties", () => {
    const hiddenPropertyObject = {};
    Object.defineProperty(hiddenPropertyObject, "secret", {
      enumerable: false,
      value: 1,
    });

    expect(isKernelRecord(hiddenPropertyObject)).toBe(false);
    expect(() => assertKernelRecord(hiddenPropertyObject, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
  });

  test("rejects objects with enumerable accessor properties", () => {
    let getterCalls = 0;
    const accessorObject = {};
    Object.defineProperty(accessorObject, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls;
      },
    });

    expect(isKernelRecord(accessorObject)).toBe(false);
    expect(getterCalls).toBe(0);
    expect(() => assertKernelRecord(accessorObject, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
    expect(getterCalls).toBe(0);
  });

  test("rejects cyclic objects and arrays without overflowing the stack", () => {
    const cyclicObject: { self?: unknown } = {};
    cyclicObject.self = cyclicObject;

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    expect(isKernelRecord(cyclicObject)).toBe(false);
    expect(isKernelRecord(cyclicArray)).toBe(false);
    expect(() => assertKernelRecord(cyclicObject, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
    expect(() => assertKernelRecord(cyclicArray, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
  });

  test("rejects negative zero as a non-canonical kernel integer", () => {
    expect(isKernelRecord(-0)).toBe(false);
    expect(isKernelRecord({ n: -0 })).toBe(false);
    expect(() => assertKernelRecord(-0, "record")).toThrow(
      "record must match the restricted Kraken kernel record profile"
    );
  });

  test("normalizes insertion-order variants to identical deterministic bytes", () => {
    const encodedVariants = kernelRecordInsertionOrderVariants.map((variant) =>
      Buffer.from(encodeDeterministicKernelRecord(variant)).toString("hex")
    );

    expect(new Set(encodedVariants).size).toBe(1);
  });

  test("sorts keys by deterministic CBOR key bytes rather than plain string order", () => {
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord({ aa: 1, b: 2 })
    ).toString("hex");

    expect(encodedHex).toBe("a261620262616101");
  });

  test("preserves RFC 8949 key order for mixed integer-like and string keys", () => {
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord({ "100": 2, z: 1 })
    ).toString("hex");

    expect(encodedHex).toBe("a2617a016331303002");
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

  test("encodes Uint8Array as a plain CBOR byte string without tag 64", () => {
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord({ bytes: new Uint8Array([1, 2, 3, 4]) })
    ).toString("hex");

    expect(encodedHex).toContain("65734401020304");
    expect(encodedHex).not.toContain("d84044");
  });

  test("rejects Uint8Array values with non-canonical metadata", () => {
    const hiddenPropertyBytes = new Uint8Array([1, 2]);
    Object.defineProperty(hiddenPropertyBytes, "secret", {
      enumerable: false,
      value: 3,
    });

    const accessorBytes = new Uint8Array([1, 2]);
    Object.defineProperty(accessorBytes, "extra", {
      enumerable: true,
      get() {
        return 3;
      },
    });

    const symbolBytes = new Uint8Array([1, 2]);
    symbolBytes[Symbol("meta")] = 3;

    expect(isKernelRecord(hiddenPropertyBytes)).toBe(false);
    expect(isKernelRecord(accessorBytes)).toBe(false);
    expect(isKernelRecord(symbolBytes)).toBe(false);
  });
});

describe("KrakenError", () => {
  test("accepts lowercase snake_case error codes", () => {
    expect(isKrakenErrorCode("invalid_schema")).toBe(true);
    expect(() =>
      assertKrakenErrorCode("store_write_failed", "code")
    ).not.toThrow();
  });

  test("rejects invalid public error code shapes", () => {
    expect(isKrakenErrorCode("Not_Snake_Case")).toBe(false);
    expect(() => assertKrakenErrorCode("Not_Snake_Case", "code")).toThrow(
      "code must be a lowercase snake_case Kraken error code"
    );
    expect(
      () => new KrakenValidationError("bad", { code: "Not_Snake_Case" })
    ).toThrow("options.code must be a lowercase snake_case Kraken error code");
  });

  test("stores code, details, and cause on the base contract", () => {
    const cause = new Error("root cause");
    const error = new KrakenValidationError("invalid schema", {
      cause,
      code: "invalid_schema",
      details: { path: "messages" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(KrakenValidationError);
    expect(error.code).toBe("invalid_schema");
    expect(error.details).toEqual({ path: "messages" });
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("KrakenValidationError");
  });

  test("preserves subclass categories for downstream normalization", () => {
    const persistenceError = new KrakenPersistenceError("write failed", {
      code: "store_write_failed",
    });
    const runtimeError = new KrakenRuntimeError("loop policy failed", {
      code: "invalid_loop_policy",
    });

    expect(persistenceError).toBeInstanceOf(KrakenPersistenceError);
    expect(runtimeError).toBeInstanceOf(KrakenRuntimeError);
  });
});
