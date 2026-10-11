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

import { describe, expect, test } from "bun:test";

import { TuvrenValidationError } from "@tuvren/core";

import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
} from "../src/index.ts";
import {
  rejectionOf,
  restorePrototypeValue,
} from "./kernel-contract-test-helpers.ts";
import {
  kernelProtocolDeterministicFixtures,
  kernelProtocolInvalidFixtures,
  kernelProtocolLogicalFixtures,
  kernelProtocolStoredFixtures,
} from "./kernel-protocol-fixtures.js";
import { deterministicKernelRecordFixture } from "./kernel-record-fixtures.js";

const invokeHashTurnTreeIdentity = async (
  schemaId: string,
  manifest: unknown,
  schema: unknown
): Promise<unknown> => {
  const result: unknown = Reflect.apply(hashTurnTreeIdentity, undefined, [
    schemaId,
    manifest,
    schema,
  ]);
  if (!(result instanceof Promise)) {
    throw new Error("Expected a hashing Promise");
  }
  return await result;
};

const invokeHashTurnNodeIdentity = async (value: unknown): Promise<unknown> => {
  const result: unknown = Reflect.apply(hashTurnNodeIdentity, undefined, [
    value,
  ]);
  if (!(result instanceof Promise)) {
    throw new Error("Expected a hashing Promise");
  }
  return await result;
};

describe("deterministic identity", () => {
  test("returns rejected Promises for invalid record and TurnTree identity inputs", async () => {
    let recordOperation: Promise<string> | undefined;
    let treeOperation: Promise<string> | undefined;
    expect(() => {
      recordOperation = hashKernelRecord(Number.NaN);
    }).not.toThrow();
    expect(() => {
      treeOperation = hashTurnTreeIdentity(
        "",
        {},
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      );
    }).not.toThrow();
    if (recordOperation === undefined || treeOperation === undefined) {
      throw new Error("Hash helpers must return Promises");
    }
    const recordError = await rejectionOf(recordOperation);
    const treeError = await rejectionOf(treeOperation);
    expect(recordError).toBeInstanceOf(TypeError);
    expect(recordError).toMatchObject({
      message: "value must match the restricted runtime kernel record profile",
      name: "TypeError",
    });
    expect(treeError).toBeInstanceOf(TuvrenValidationError);
    expect(treeError).toMatchObject({
      code: "invalid_turn_tree_hash",
      message: "schemaId must be a non-empty string",
    });
  });
  test("matches the shared canonical kernel-record fixture bytes and hash", async () => {
    const encodedBytes = encodeDeterministicKernelRecord(
      deterministicKernelRecordFixture.logicalValue
    );
    const encodedHex = Buffer.from(encodedBytes).toString("hex");
    const digestHex = await hashKernelRecord(
      deterministicKernelRecordFixture.logicalValue
    );

    expect(encodedHex).toBe(deterministicKernelRecordFixture.expectedCborHex);
    expect(digestHex).toBe(deterministicKernelRecordFixture.expectedSha256Hex);
  });

  test("round-trips deterministic kernel records through decode", () => {
    const decodedValue = decodeDeterministicKernelRecord(
      encodeDeterministicKernelRecord(
        deterministicKernelRecordFixture.logicalValue
      )
    );

    expect(decodedValue).toEqual(deterministicKernelRecordFixture.logicalValue);
  });

  test("round-trips reserved object-property names like __proto__", () => {
    const nested = { ok: 1 };
    Object.setPrototypeOf(nested, null);
    const logicalValue = { ["__proto__"]: nested };
    Object.setPrototypeOf(logicalValue, null);

    const decodedValue = decodeDeterministicKernelRecord(
      encodeDeterministicKernelRecord(logicalValue)
    );

    if (
      decodedValue === null ||
      typeof decodedValue !== "object" ||
      Array.isArray(decodedValue) ||
      decodedValue instanceof Uint8Array
    ) {
      throw new Error("decoded value must remain an object record");
    }

    const protoDescriptor = Object.getOwnPropertyDescriptor(
      decodedValue,
      "__proto__"
    );

    expect(Object.getPrototypeOf(decodedValue)).toBeNull();
    expect(Object.hasOwn(decodedValue, "__proto__")).toBe(true);
    expect(protoDescriptor?.value).toEqual(nested);
  });

  test("rejects non-canonical deterministic CBOR encodings on decode", () => {
    expect(() =>
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidNonCanonicalKernelRecordBytes
      )
    ).toThrow("must already use the canonical deterministic CBOR encoding");
  });

  test("wraps malformed deterministic CBOR bytes in TuvrenValidationError", () => {
    let caughtError: unknown;

    try {
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidTruncatedKernelRecordBytes
      );
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TuvrenValidationError);
    expect(caughtError).toBeInstanceOf(Error);
    if (!(caughtError instanceof Error)) {
      throw new Error("Expected a validation Error");
    }
    expect(caughtError.message).toContain(
      "must contain valid deterministic CBOR"
    );
  });

  test("rejects malformed TurnNode identity inputs with TuvrenValidationError", async () => {
    const missingIdentityInput: unknown = undefined;
    expect(
      await rejectionOf(invokeHashTurnNodeIdentity(missingIdentityInput))
    ).toBeInstanceOf(TuvrenValidationError);
    const rejectedError1 = await rejectionOf(
      invokeHashTurnNodeIdentity(missingIdentityInput)
    );
    expect(rejectedError1.message).toContain(
      "turn node identity input must be a plain object"
    );
    const rejectedError2 = await rejectionOf(
      invokeHashTurnNodeIdentity({
        consumedStagedResults: [],
        eventHash: 5,
        previousTurnNodeHash: null,
        schemaId: 7,
        turnTreeHash: 8,
      })
    );
    expect(rejectedError2.message).toContain(
      "turn node identity input.eventHash"
    );
  });

  test("rejects TurnNode identity inputs that rely on inherited required fields", async () => {
    const objectPrototype = Object.prototype;
    const originalEventHash: unknown = Reflect.get(
      objectPrototype,
      "eventHash"
    );
    const hadEventHash = Object.hasOwn(objectPrototype, "eventHash");
    const originalPreviousTurnNodeHash: unknown = Reflect.get(
      objectPrototype,
      "previousTurnNodeHash"
    );
    const hadPreviousTurnNodeHash = Object.hasOwn(
      objectPrototype,
      "previousTurnNodeHash"
    );
    const originalSchemaId: unknown = Reflect.get(objectPrototype, "schemaId");
    const hadSchemaId = Object.hasOwn(objectPrototype, "schemaId");
    const originalTurnTreeHash: unknown = Reflect.get(
      objectPrototype,
      "turnTreeHash"
    );
    const hadTurnTreeHash = Object.hasOwn(objectPrototype, "turnTreeHash");

    Reflect.set(objectPrototype, "eventHash", null);
    Reflect.set(objectPrototype, "previousTurnNodeHash", null);
    Reflect.set(objectPrototype, "schemaId", "schema_main");
    Reflect.set(
      objectPrototype,
      "turnTreeHash",
      "abababababababababababababababababababababababababababababababab"
    );

    try {
      const rejectedError3 = await rejectionOf(
        invokeHashTurnNodeIdentity({ consumedStagedResults: [] })
      );
      expect(rejectedError3.message).toContain(
        "turn node identity input.eventHash"
      );
    } finally {
      restorePrototypeValue(
        objectPrototype,
        "eventHash",
        hadEventHash,
        originalEventHash
      );
      restorePrototypeValue(
        objectPrototype,
        "previousTurnNodeHash",
        hadPreviousTurnNodeHash,
        originalPreviousTurnNodeHash
      );
      restorePrototypeValue(
        objectPrototype,
        "schemaId",
        hadSchemaId,
        originalSchemaId
      );
      restorePrototypeValue(
        objectPrototype,
        "turnTreeHash",
        hadTurnTreeHash,
        originalTurnTreeHash
      );
    }
  });

  test("rejects TurnNode identity inputs with invalid staged-result interrupt semantics", async () => {
    const rejectedError4 = await rejectionOf(
      invokeHashTurnNodeIdentity({
        consumedStagedResults: [
          {
            objectHash:
              "1111111111111111111111111111111111111111111111111111111111111111",
            objectType: "tool_result",
            status: "interrupted",
            taskId: "tool_call_1",
            timestamp: 1_717_171_717_171,
          },
        ],
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: "schema_main",
        turnTreeHash:
          "2222222222222222222222222222222222222222222222222222222222222222",
      })
    );
    expect(rejectedError4.message).toContain(
      'interruptPayload is required when status is "interrupted"'
    );
    const rejectedError5 = await rejectionOf(
      invokeHashTurnNodeIdentity({
        consumedStagedResults: [
          {
            interruptPayload: { reason: "awaiting_approval" },
            objectHash:
              "1111111111111111111111111111111111111111111111111111111111111111",
            objectType: "tool_result",
            status: "completed",
            taskId: "tool_call_1",
            timestamp: 1_717_171_717_171,
          },
        ],
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: "schema_main",
        turnTreeHash:
          "2222222222222222222222222222222222222222222222222222222222222222",
      })
    );
    expect(rejectedError5.message).toContain(
      'interruptPayload must be omitted unless status is "interrupted"'
    );
    const rejectedError6 = await rejectionOf(
      invokeHashTurnNodeIdentity({
        consumedStagedResults: [
          {
            objectHash:
              "1111111111111111111111111111111111111111111111111111111111111111",
            objectType: "tool_result",
            status: "completed",
            taskId: "tool_call_1",
            timestamp: 1_717_171_717_171,
          },
          {
            objectHash:
              "1212121212121212121212121212121212121212121212121212121212121212",
            objectType: "tool_result",
            status: "failed",
            taskId: "tool_call_1",
            timestamp: 1_717_171_717_272,
          },
        ],
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: "schema_main",
        turnTreeHash:
          "2222222222222222222222222222222222222222222222222222222222222222",
      })
    );
    expect(rejectedError6.message).toContain(
      "must not contain duplicate staged result taskIds"
    );
  });

  test("rejects TurnNode identity inputs with non-data consumedStagedResults arrays", async () => {
    const consumedStagedResults = Object.assign(
      [
        {
          objectHash:
            "1111111111111111111111111111111111111111111111111111111111111111",
          objectType: "tool_result",
          status: "completed",
          taskId: "tool_call_1",
          timestamp: 1_717_171_717_171,
        },
      ],
      { meta: 1 }
    );

    const rejectedError7 = await rejectionOf(
      invokeHashTurnNodeIdentity({
        consumedStagedResults,
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: "schema_main",
        turnTreeHash:
          "2222222222222222222222222222222222222222222222222222222222222222",
      })
    );
    expect(rejectedError7.message).toContain(
      "consumedStagedResults must be a dense data-only array"
    );
  });

  test("rejects decoded non-canonical kernel numbers as validation errors", () => {
    expect(() =>
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidNonCanonicalKernelNumberBytes.float
      )
    ).toThrow("decoded to a non-canonical kernel number");
    expect(() =>
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidNonCanonicalKernelNumberBytes.nan
      )
    ).toThrow("decoded to a non-canonical kernel number");
    expect(() =>
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidNonCanonicalKernelNumberBytes
          .infinity
      )
    ).toThrow("decoded to a non-canonical kernel number");
  });

  test("locks the canonical TurnTreeSchema bytes and hash", async () => {
    const schemaRecord = decodeDeterministicKernelRecord(
      Uint8Array.from(
        Buffer.from(
          kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex,
          "hex"
        )
      )
    );
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord(schemaRecord)
    ).toString("hex");
    const digestHex = await hashKernelRecord(schemaRecord);

    expect(encodedHex).toBe(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex
    );
    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecordSha256Hex
    );
  });

  test("locks the canonical TurnNode identity-preimage bytes and digest", async () => {
    const turnNodeIdentityRecord = decodeDeterministicKernelRecord(
      Uint8Array.from(
        Buffer.from(
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecordCborHex,
          "hex"
        )
      )
    );
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord(turnNodeIdentityRecord)
    ).toString("hex");
    const digestHex = await invokeHashTurnNodeIdentity(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
    );

    expect(encodedHex).toBe(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecordCborHex
    );
    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecordSha256Hex
    );
  });

  test("rejects malformed TurnTree manifest inputs before hashing identity", async () => {
    const rejectedError8 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        {
          "context.manifest":
            "2222222222222222222222222222222222222222222222222222222222222222",
          messages: 1,
        },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    );
    expect(rejectedError8.message).toContain(
      "manifest.messages must be a HashString[] for an ordered path"
    );
    const rejectedError9 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        {
          "context.manifest":
            "2222222222222222222222222222222222222222222222222222222222222222",
          messages: ["not_hash"],
        },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    );
    expect(rejectedError9.message).toContain(
      "manifest.messages[0] must be a lowercase 64-character SHA-256 hex digest"
    );
    const rejectedError10 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        {
          "bad..path": null,
          "context.manifest":
            "2222222222222222222222222222222222222222222222222222222222222222",
          messages: [],
        },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    );
    expect(rejectedError10.message).toContain(
      "manifest.bad..path must reference a schema-defined path"
    );
    const rejectedError11 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.invalidSchemaWithConflictingDuplicatePathDefinitions
      )
    );
    expect(rejectedError11.message).toContain(
      "schema.paths must not contain duplicate schema paths"
    );
    const rejectedError12 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.invalidSchemaWithDateMetadata
      )
    );
    expect(rejectedError12.message).toContain("schema.paths[0].metadata");
    const rejectedError13 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.unknownPathSchema
      )
    );
    expect(rejectedError13.message).toContain(
      "schema.incorporationRules[0].targetPath must reference a defined schema path"
    );
    const rejectedError14 = await rejectionOf(
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.invalidSchemaWithNonDensePathsArray
      )
    );
    expect(rejectedError14.message).toContain(
      "schema.paths must be a dense data-only array"
    );
  });

  test("rejects an empty TurnTree schemaId with the TurnTree identity code", async () => {
    let caught: unknown;

    try {
      await invokeHashTurnTreeIdentity(
        "",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TuvrenValidationError);
    if (!(caught instanceof TuvrenValidationError)) {
      throw new Error("Expected TuvrenValidationError");
    }
    expect(caught.code).toBe("invalid_turn_tree_hash");
    expect(caught.message).toBe("schemaId must be a non-empty string");
  });

  test("hashes opaque object bytes without structured-record canonicalization", async () => {
    const digestHex = await hashOpaqueObjectBytes(
      kernelProtocolDeterministicFixtures.rawOpaqueBytes
    );

    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.rawOpaqueBytesSha256Hex
    );
  });

  test("locks canonical stored CBOR payload bytes", () => {
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedOrderedPathChunk.itemsCbor
      ).toString("hex")
    ).toBe(
      kernelProtocolDeterministicFixtures.storedOrderedPathChunkItemsCborHex
    );
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedRun.createdTurnNodesCbor
      ).toString("hex")
    ).toBe(
      kernelProtocolDeterministicFixtures.storedRunCreatedTurnNodesCborHex
    );
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedRun.stepSequenceCbor
      ).toString("hex")
    ).toBe(kernelProtocolDeterministicFixtures.storedRunStepSequenceCborHex);
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedSchema.schemaCbor
      ).toString("hex")
    ).toBe(kernelProtocolDeterministicFixtures.storedSchemaSchemaCborHex);
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedStagedResult.interruptPayloadCbor
      ).toString("hex")
    ).toBe(
      kernelProtocolDeterministicFixtures.storedStagedResultInterruptPayloadCborHex
    );
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedTurnNode.consumedStagedResultsCbor
      ).toString("hex")
    ).toBe(
      kernelProtocolDeterministicFixtures.storedTurnNodeConsumedStagedResultsCborHex
    );
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedTurnTree.manifestCbor
      ).toString("hex")
    ).toBe(kernelProtocolDeterministicFixtures.storedTurnTreeManifestCborHex);
    expect(
      Buffer.from(
        kernelProtocolStoredFixtures.storedTurnTreePathOrdered.orderedInlineCbor
      ).toString("hex")
    ).toBe(
      kernelProtocolDeterministicFixtures.storedTurnTreePathOrderedInlineCborHex
    );
  });
});
