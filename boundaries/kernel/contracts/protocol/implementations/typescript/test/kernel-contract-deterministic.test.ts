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
import { TuvrenValidationError } from "@tuvren/core-types";
import { deterministicKernelRecordFixture } from "../../../../../../shared/contracts/core-types/implementations/typescript/test/kernel-record-fixtures.js";
import {
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
} from "../src/index.ts";
import { restorePrototypeValue } from "./kernel-contract-test-helpers.ts";
import {
  kernelProtocolDeterministicFixtures,
  kernelProtocolInvalidFixtures,
  kernelProtocolLogicalFixtures,
  kernelProtocolStoredFixtures,
} from "./kernel-protocol-fixtures.js";

function invokeHashTurnTreeIdentity(
  schemaId: string,
  manifest: unknown,
  schema: unknown
): Promise<string> {
  return Reflect.apply(hashTurnTreeIdentity, undefined, [
    schemaId,
    manifest,
    schema,
  ]);
}

describe("deterministic identity", () => {
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
    const logicalValue = Object.assign(Object.create(null), {
      ["__proto__"]: Object.assign(Object.create(null), { ok: 1 }),
    });

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
    expect(protoDescriptor?.value).toEqual(
      Object.assign(Object.create(null), { ok: 1 })
    );
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
    expect((caughtError as Error).message).toContain(
      "must contain valid deterministic CBOR"
    );
  });

  test("rejects malformed TurnNode identity inputs with TuvrenValidationError", async () => {
    await expect(
      hashTurnNodeIdentity(undefined as never)
    ).rejects.toBeInstanceOf(TuvrenValidationError);
    await expect(hashTurnNodeIdentity(undefined as never)).rejects.toThrow(
      "turn node identity input must be a plain object"
    );
    await expect(
      hashTurnNodeIdentity({
        consumedStagedResults: [],
        eventHash: 5,
        previousTurnNodeHash: null,
        schemaId: 7,
        turnTreeHash: 8,
      } as never)
    ).rejects.toThrow("turn node identity input.eventHash");
  });

  test("rejects TurnNode identity inputs that rely on inherited required fields", async () => {
    const objectPrototype = Object.prototype as Record<string, unknown>;
    const originalEventHash = objectPrototype.eventHash;
    const hadEventHash = Object.hasOwn(objectPrototype, "eventHash");
    const originalPreviousTurnNodeHash = objectPrototype.previousTurnNodeHash;
    const hadPreviousTurnNodeHash = Object.hasOwn(
      objectPrototype,
      "previousTurnNodeHash"
    );
    const originalSchemaId = objectPrototype.schemaId;
    const hadSchemaId = Object.hasOwn(objectPrototype, "schemaId");
    const originalTurnTreeHash = objectPrototype.turnTreeHash;
    const hadTurnTreeHash = Object.hasOwn(objectPrototype, "turnTreeHash");

    objectPrototype.eventHash = null;
    objectPrototype.previousTurnNodeHash = null;
    objectPrototype.schemaId = "schema_main";
    objectPrototype.turnTreeHash =
      "abababababababababababababababababababababababababababababababab";

    try {
      await expect(
        hashTurnNodeIdentity({ consumedStagedResults: [] } as never)
      ).rejects.toThrow("turn node identity input.eventHash");
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
    await expect(
      hashTurnNodeIdentity({
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
      } as never)
    ).rejects.toThrow(
      'interruptPayload is required when status is "interrupted"'
    );
    await expect(
      hashTurnNodeIdentity({
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
      } as never)
    ).rejects.toThrow(
      'interruptPayload must be omitted unless status is "interrupted"'
    );
    await expect(
      hashTurnNodeIdentity({
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
      } as never)
    ).rejects.toThrow("must not contain duplicate staged result taskIds");
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

    await expect(
      hashTurnNodeIdentity({
        consumedStagedResults,
        eventHash: null,
        previousTurnNodeHash: null,
        schemaId: "schema_main",
        turnTreeHash:
          "2222222222222222222222222222222222222222222222222222222222222222",
      } as never)
    ).rejects.toThrow("consumedStagedResults must be a dense data-only array");
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
    const digestHex = await hashTurnNodeIdentity(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
    );

    expect(encodedHex).toBe(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecordCborHex
    );
    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecordSha256Hex
    );
  });

  test("rejects malformed TurnTree manifest inputs before hashing identity", () => {
    expect(() =>
      hashTurnTreeIdentity(
        "schema_main",
        {
          "context.manifest":
            "2222222222222222222222222222222222222222222222222222222222222222",
          messages: 1,
        } as never,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow("manifest.messages must be a HashString[] for an ordered path");
    expect(() =>
      hashTurnTreeIdentity(
        "schema_main",
        {
          "context.manifest":
            "2222222222222222222222222222222222222222222222222222222222222222",
          messages: ["not_hash"],
        } as never,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow(
      "manifest.messages[0] must be a lowercase 64-character SHA-256 hex digest"
    );
    expect(() =>
      hashTurnTreeIdentity(
        "schema_main",
        {
          "context.manifest":
            "2222222222222222222222222222222222222222222222222222222222222222",
          "bad..path": null,
          messages: [],
        } as never,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow("manifest.bad..path must reference a schema-defined path");
    expect(() =>
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.invalidSchemaWithConflictingDuplicatePathDefinitions
      )
    ).toThrow("schema.paths must not contain duplicate schema paths");
    expect(() =>
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.invalidSchemaWithDateMetadata
      )
    ).toThrow("schema.paths[0].metadata");
    expect(() =>
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.unknownPathSchema
      )
    ).toThrow(
      "schema.incorporationRules[0].targetPath must reference a defined schema path"
    );
    expect(() =>
      invokeHashTurnTreeIdentity(
        "schema_main",
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolInvalidFixtures.invalidSchemaWithNonDensePathsArray
      )
    ).toThrow("schema.paths must be a dense data-only array");
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
