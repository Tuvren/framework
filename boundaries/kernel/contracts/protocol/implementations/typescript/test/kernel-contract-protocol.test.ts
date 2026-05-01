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
import type { ComposedVerdict, KernelSignal, Verdict } from "../src/index.ts";
import {
  assertBranchHeadListEntry,
  assertBranchRecord,
  assertComposedVerdict,
  assertObserveResult,
  assertPathValue,
  assertPathValueForCollectionKind,
  assertRecoveryState,
  assertRunRecord,
  assertRunStatus,
  assertSetHeadResult,
  assertStagedResult,
  assertStagedResultStatus,
  assertStepContext,
  assertStepDeclaration,
  assertStoredBranch,
  assertStoredObject,
  assertStoredObjectIdentity,
  assertStoredOrderedPathChunk,
  assertStoredOrderedPathChunkIdentity,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnNodeIdentity,
  assertStoredTurnTree,
  assertStoredTurnTreeIdentity,
  assertStoredTurnTreePath,
  assertThreadCreateResult,
  assertThreadRecord,
  assertTurnNode,
  assertTurnNodeIdentity,
  assertTurnRecord,
  assertTurnTreeChangeSet,
  assertTurnTreeManifest,
  assertTurnTreeSchema,
  assertVerdict,
  assertVerdictDisposition,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  hashTurnTreeIdentity,
  isBranchHeadListEntry,
  isObserveResult,
  isRunStatus,
  isStagedResultStatus,
  isVerdict,
  isVerdictDisposition,
} from "../src/index.ts";
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

describe("schema validation", () => {
  test("accepts the canonical TurnTreeSchema fixture", () => {
    expect(() =>
      assertTurnTreeSchema(
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).not.toThrow();
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      assertTurnTreeSchema(kernelProtocolInvalidFixtures.duplicatePathSchema)
    ).toThrow("must not contain duplicate schema paths");
  });

  test("rejects duplicate objectType mappings", () => {
    expect(() =>
      assertTurnTreeSchema(kernelProtocolInvalidFixtures.duplicateRuleSchema)
    ).toThrow("must not contain duplicate objectType mappings");
  });

  test("rejects unknown incorporation target paths", () => {
    expect(() =>
      assertTurnTreeSchema(kernelProtocolInvalidFixtures.unknownPathSchema)
    ).toThrow("must reference a defined schema path");
  });

  test("rejects malformed schema path grammar", () => {
    expect(() =>
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaPathSchema
      )
    ).toThrow("must be a dot-separated path with non-empty segments");
    expect(() =>
      assertTurnTreeChangeSet(
        {
          "messages..results":
            "5858585858585858585858585858585858585858585858585858585858585858",
        },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow("must be a dot-separated path with non-empty segments");
  });

  test("rejects schema records with symbol keys or accessor-backed fields", () => {
    expect(() =>
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaWithSymbolKey
      )
    ).toThrow("must be a plain object");
    expect(() =>
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaWithAccessorPathMetadata
      )
    ).toThrow("must be a plain object");
    expect(() =>
      assertTurnTreeSchema(
        kernelProtocolInvalidFixtures.invalidSchemaWithDateMetadata
      )
    ).toThrow("must match the restricted runtime kernel record profile");
  });

  test("does not accept required fields inherited from Object.prototype", () => {
    const objectPrototype = Object.prototype as Record<string, unknown>;
    const originalSchemaId = objectPrototype.schemaId;
    const originalPaths = objectPrototype.paths;
    const originalIncorporationRules = objectPrototype.incorporationRules;
    const originalId = objectPrototype.id;
    const originalDeterministic = objectPrototype.deterministic;
    const originalSideEffects = objectPrototype.sideEffects;
    const hadSchemaId = Object.hasOwn(objectPrototype, "schemaId");
    const hadPaths = Object.hasOwn(objectPrototype, "paths");
    const hadIncorporationRules = Object.hasOwn(
      objectPrototype,
      "incorporationRules"
    );
    const hadId = Object.hasOwn(objectPrototype, "id");
    const hadDeterministic = Object.hasOwn(objectPrototype, "deterministic");
    const hadSideEffects = Object.hasOwn(objectPrototype, "sideEffects");

    objectPrototype.schemaId = "schema_main";
    objectPrototype.paths = [{ path: "messages", collection: "ordered" }];
    objectPrototype.incorporationRules = [];
    objectPrototype.id = "model_call";
    objectPrototype.deterministic = false;
    objectPrototype.sideEffects = false;

    try {
      expect(() => assertTurnTreeSchema({})).toThrow(
        "schemaId must be a non-empty string"
      );
      expect(() => assertStepDeclaration({})).toThrow(
        "id must be a non-empty string"
      );
    } finally {
      restorePrototypeValue(
        objectPrototype,
        "schemaId",
        hadSchemaId,
        originalSchemaId
      );
      restorePrototypeValue(objectPrototype, "paths", hadPaths, originalPaths);
      restorePrototypeValue(
        objectPrototype,
        "incorporationRules",
        hadIncorporationRules,
        originalIncorporationRules
      );
      restorePrototypeValue(objectPrototype, "id", hadId, originalId);
      restorePrototypeValue(
        objectPrototype,
        "deterministic",
        hadDeterministic,
        originalDeterministic
      );
      restorePrototypeValue(
        objectPrototype,
        "sideEffects",
        hadSideEffects,
        originalSideEffects
      );
    }
  });

  test("enforces collection-kind-specific path values", () => {
    expect(() =>
      assertPathValueForCollectionKind(
        kernelProtocolLogicalFixtures.turnTreeChangeSet.messages,
        "ordered"
      )
    ).not.toThrow();
    expect(() =>
      assertPathValueForCollectionKind(
        kernelProtocolLogicalFixtures.turnTreeChangeSet["context.manifest"],
        "single"
      )
    ).not.toThrow();
    expect(() =>
      assertPathValueForCollectionKind(
        kernelProtocolLogicalFixtures.turnTreeChangeSet.messages,
        "single"
      )
    ).toThrow("must be a HashString or null for a single path");
  });

  test("rejects sparse ordered-path arrays", () => {
    expect(() =>
      assertPathValue(
        kernelProtocolInvalidFixtures.invalidSparseOrderedPathValue
      )
    ).toThrow("must be a HashString, HashString[], or null");
    expect(() =>
      assertPathValueForCollectionKind(
        kernelProtocolInvalidFixtures.invalidSparseOrderedPathValue,
        "ordered"
      )
    ).toThrow("must be a HashString[] for an ordered path");
  });

  test("rejects non-data array shapes in path validation", () => {
    expect(() =>
      assertPathValueForCollectionKind(
        kernelProtocolInvalidFixtures.invalidArrayWithEnumerableMetadata,
        "ordered"
      )
    ).toThrow("must be a HashString[] for an ordered path");
    expect(() =>
      assertPathValueForCollectionKind(
        kernelProtocolInvalidFixtures.invalidArrayWithAccessorIndex,
        "ordered"
      )
    ).toThrow("must be a HashString[] for an ordered path");
  });

  test("does not accept sparse arrays that borrow values from Array.prototype", () => {
    const inheritedHash =
      "4848484848484848484848484848484848484848484848484848484848484848";
    const originalPrototypeValue = Array.prototype[0];
    const hadPrototypeValue = Object.hasOwn(Array.prototype, 0);

    Array.prototype[0] = inheritedHash;

    try {
      expect(() =>
        assertObserveResult({ annotations: new Array(1), signals: [] })
      ).toThrow("annotations must be a dense data-only array");
      expect(() =>
        assertStepContext({
          currentTurnNodeHash:
            "4949494949494949494949494949494949494949494949494949494949494949",
          schema: {
            schemaId: "schema_main",
            paths: [{ path: "messages", collection: "ordered" }],
            incorporationRules: [],
          },
          signals: new Array(1),
          step: {
            deterministic: false,
            id: "model_call",
            sideEffects: false,
          },
        })
      ).toThrow("signals must be a dense data-only array");
    } finally {
      if (hadPrototypeValue) {
        Array.prototype[0] = originalPrototypeValue;
      } else {
        Reflect.deleteProperty(Array.prototype, 0);
      }
    }
  });
});

function restorePrototypeValue(
  target: Record<PropertyKey, unknown>,
  key: PropertyKey,
  hadOwn: boolean,
  originalValue: unknown
): void {
  if (hadOwn) {
    target[key] = originalValue;
    return;
  }

  Reflect.deleteProperty(target, key);
}

describe("logical contract fixtures", () => {
  test("accepts the canonical logical record fixtures", () => {
    expect(() =>
      assertBranchHeadListEntry(
        kernelProtocolLogicalFixtures.branchHeadListEntry
      )
    ).not.toThrow();
    expect(() =>
      assertThreadRecord(kernelProtocolLogicalFixtures.threadRecord)
    ).not.toThrow();
    expect(() =>
      assertTurnNode(kernelProtocolLogicalFixtures.turnNode)
    ).not.toThrow();
    expect(() =>
      assertTurnRecord(kernelProtocolLogicalFixtures.turnRecord)
    ).not.toThrow();
    expect(() =>
      assertRunRecord(kernelProtocolLogicalFixtures.runRecord)
    ).not.toThrow();
    expect(() =>
      assertStagedResult(kernelProtocolLogicalFixtures.stagedResult)
    ).not.toThrow();
    expect(() =>
      assertStepContext(kernelProtocolLogicalFixtures.stepContext)
    ).not.toThrow();
    expect(() =>
      assertRecoveryState(kernelProtocolLogicalFixtures.recoveryState)
    ).not.toThrow();
    expect(() =>
      assertThreadCreateResult(kernelProtocolLogicalFixtures.threadCreateResult)
    ).not.toThrow();
    expect(() =>
      assertSetHeadResult(kernelProtocolLogicalFixtures.setHeadResult)
    ).not.toThrow();
    expect(() =>
      assertTurnTreeChangeSet(
        kernelProtocolLogicalFixtures.turnTreeChangeSet,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).not.toThrow();
    expect(() =>
      assertObserveResult(kernelProtocolLogicalFixtures.observeResult)
    ).not.toThrow();
  });

  test("exports KernelSignal as part of the public protocol surface", () => {
    const signal: KernelSignal = { kind: "carry_forward", level: 1 };

    expect(() =>
      assertObserveResult({
        annotations: [{ kind: "note" }],
        signals: [signal],
      })
    ).not.toThrow();
  });

  test("exports verdict algebra types as part of the public protocol surface", () => {
    const verdict: Verdict = {
      disposition: "HardFail",
      kind: "abort",
      reason: "blocked",
    };
    const composedVerdict: ComposedVerdict = verdict;

    expect(composedVerdict.kind).toBe("abort");
  });

  test("validates verdict algebra shapes at runtime", () => {
    expect(isVerdictDisposition("HardFail")).toBe(true);
    expect(isVerdictDisposition("explode")).toBe(false);
    expect(() => assertVerdictDisposition("SoftFail")).not.toThrow();
    expect(() =>
      assertVerdict({
        disposition: "HardFail",
        kind: "abort",
        reason: "blocked",
      })
    ).not.toThrow();
    expect(() =>
      assertComposedVerdict({
        kind: "pause",
        reason: "waiting",
        resumptionSchema: { kind: "approval" },
      })
    ).not.toThrow();
    expect(isVerdict({ kind: "proceed" })).toBe(true);
    expect(() =>
      assertVerdict({
        kind: "abort",
        reason: "blocked",
      })
    ).toThrow("disposition");
    expect(() =>
      assertVerdict({
        adjustment: { retries: 1 },
        kind: "retry",
        extra: true,
      })
    ).toThrow("extra is not part of the contract shape");
  });

  test("wraps primitive field failures in TuvrenValidationError", () => {
    let turnNodeError: unknown;
    let storedObjectError: unknown;

    try {
      assertTurnNode({
        ...kernelProtocolLogicalFixtures.turnNode,
        hash: "bad",
      });
    } catch (error: unknown) {
      turnNodeError = error;
    }

    try {
      assertStoredObject({
        ...kernelProtocolStoredFixtures.storedObject,
        hash: "bad",
      });
    } catch (error: unknown) {
      storedObjectError = error;
    }

    expect(turnNodeError).toBeInstanceOf(TuvrenValidationError);
    expect(storedObjectError).toBeInstanceOf(TuvrenValidationError);
  });

  test("enforces canonical TurnNode identity hashes", async () => {
    await expect(
      assertTurnNodeIdentity(kernelProtocolLogicalFixtures.turnNode)
    ).resolves.toBeUndefined();
    await expect(
      assertTurnNodeIdentity({
        ...kernelProtocolLogicalFixtures.turnNode,
        hash: "5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b",
      })
    ).rejects.toThrow("hash must match the canonical TurnNode identity hash");
  });

  test("rejects stored-only metadata on logical lifecycle records", () => {
    expect(() =>
      assertThreadRecord({
        ...kernelProtocolLogicalFixtures.threadRecord,
        createdAtMs: 1_717_171_717_171,
      })
    ).toThrow("createdAtMs is not part of the contract shape");
    expect(() =>
      assertBranchRecord({
        ...kernelProtocolLogicalFixtures.branchRecord,
        archivedFromBranchId: "branch_archive",
      })
    ).toThrow("archivedFromBranchId is not part of the contract shape");
    expect(() =>
      assertTurnRecord({
        ...kernelProtocolLogicalFixtures.turnRecord,
        updatedAtMs: 1_717_171_717_272,
      })
    ).toThrow("updatedAtMs is not part of the contract shape");
    expect(() =>
      assertRunRecord({
        ...kernelProtocolLogicalFixtures.runRecord,
        createdAtMs: 1_717_171_717_171,
      })
    ).toThrow("createdAtMs is not part of the contract shape");
  });

  test("rejects impossible run step indexes", () => {
    expect(() =>
      assertRunRecord(
        kernelProtocolInvalidFixtures.invalidRunRecordPastStepSequence
      )
    ).toThrow("currentStepIndex must not exceed");
    expect(() =>
      assertRunRecord(
        kernelProtocolInvalidFixtures.invalidRunningRunRecordAtSequenceEnd
      )
    ).toThrow(
      'must reference an available step when value.status is "running"'
    );
    expect(() =>
      assertRunRecord(
        kernelProtocolInvalidFixtures.invalidRunningRunRecordWithEmptyStepSequence
      )
    ).toThrow('cannot be "running" when value.stepSequence is empty');
    expect(() =>
      assertRunRecord(
        kernelProtocolInvalidFixtures.invalidCompletedRunRecordBeforeSequenceEnd
      )
    ).toThrow(
      'must equal the declared step count in value.stepSequence when value.status is "completed"'
    );
  });

  test("rejects logical TurnNodes with stored-only timestamps", () => {
    expect(() =>
      assertTurnNode({
        ...kernelProtocolLogicalFixtures.turnNode,
        createdAtMs: 1_717_171_717_272,
      })
    ).toThrow("createdAtMs is not part of the contract shape");
  });

  test("rejects recovery states whose lastCompletedStepId is not declared", () => {
    expect(() =>
      assertRecoveryState(
        kernelProtocolInvalidFixtures.invalidRecoveryStateWithUnknownCompletedStepId
      )
    ).toThrow("lastCompletedStepId must reference a declared stepSequence id");
    expect(() =>
      assertRecoveryState(
        kernelProtocolInvalidFixtures.invalidRecoveryStateWithConsumedResultsButNullCompletedStepId
      )
    ).toThrow("lastCompletedStepId must name a completed step");
  });

  test("rejects incoherent archive results", () => {
    expect(() =>
      assertSetHeadResult({
        archiveBranch: {
          ...kernelProtocolLogicalFixtures.setHeadResult.archiveBranch,
          threadId: "thread_other",
        },
        branch: kernelProtocolLogicalFixtures.setHeadResult.branch,
      })
    ).toThrow("value.archiveBranch.threadId must match value.branch.threadId");
    expect(() =>
      assertSetHeadResult({
        archiveBranch: {
          ...kernelProtocolLogicalFixtures.setHeadResult.archiveBranch,
          branchId: kernelProtocolLogicalFixtures.setHeadResult.branch.branchId,
        },
        branch: kernelProtocolLogicalFixtures.setHeadResult.branch,
      })
    ).toThrow(
      "value.archiveBranch.branchId must differ from value.branch.branchId"
    );
    expect(() =>
      assertSetHeadResult({
        archiveBranch: {
          ...kernelProtocolLogicalFixtures.setHeadResult.archiveBranch,
          headTurnNodeHash:
            kernelProtocolLogicalFixtures.setHeadResult.branch.headTurnNodeHash,
        },
        branch: kernelProtocolLogicalFixtures.setHeadResult.branch,
      })
    ).toThrow(
      "value.archiveBranch.headTurnNodeHash must differ from value.branch.headTurnNodeHash"
    );
  });

  test("exposes status guards for runtime callers", () => {
    expect(
      isBranchHeadListEntry(kernelProtocolLogicalFixtures.branchHeadListEntry)
    ).toBe(true);
    expect(
      isBranchHeadListEntry(
        kernelProtocolInvalidFixtures.invalidBranchHeadListEntry
      )
    ).toBe(false);
    expect(isRunStatus("running")).toBe(true);
    expect(isRunStatus("broken")).toBe(false);
    expect(isStagedResultStatus("completed")).toBe(true);
    expect(isStagedResultStatus("unknown")).toBe(false);
    expect(() => assertRunStatus("paused")).not.toThrow();
    expect(() => assertStagedResultStatus("interrupted")).not.toThrow();
  });

  test("rejects invalid observe payloads", () => {
    expect(
      isObserveResult(kernelProtocolInvalidFixtures.invalidObserveResult)
    ).toBe(false);
    expect(() =>
      assertObserveResult(kernelProtocolInvalidFixtures.invalidObserveResult)
    ).toThrow("annotations[0] must be a plain object");
  });

  test("rejects staged results with undeclared extra fields", () => {
    expect(() =>
      assertStagedResult({
        ...kernelProtocolLogicalFixtures.stagedResult,
        debug: 1,
      })
    ).toThrow("debug is not part of the contract shape");
  });

  test("rejects explicit undefined for optional logical fields", () => {
    expect(() =>
      assertStepDeclaration({
        deterministic: false,
        id: "model_call",
        metadata: undefined,
        sideEffects: false,
      })
    ).toThrow("metadata must be omitted instead of undefined");
    expect(() =>
      assertSetHeadResult({
        archiveBranch: undefined,
        branch: kernelProtocolLogicalFixtures.branchRecord,
      })
    ).toThrow("archiveBranch must be omitted instead of undefined");
    expect(() =>
      assertStagedResult({
        ...kernelProtocolLogicalFixtures.stagedResult,
        interruptPayload: undefined,
      })
    ).toThrow("interruptPayload must be omitted instead of undefined");
    expect(() =>
      assertTurnTreeSchema({
        incorporationRules: [],
        paths: [
          {
            collection: "ordered",
            metadata: undefined,
            path: "messages",
          },
        ],
        schemaId: "schema_main",
      })
    ).toThrow("metadata must be omitted instead of undefined");
  });

  test("rejects invalid branch head list entries", () => {
    expect(() =>
      assertBranchHeadListEntry(
        kernelProtocolInvalidFixtures.invalidBranchHeadListEntry
      )
    ).toThrow("[0] must be a non-empty string");
  });

  test("rejects undeclared extra fields on exact-shape validators", () => {
    expect(() =>
      assertStepContext({
        ...kernelProtocolLogicalFixtures.stepContext,
        extra: 1,
      })
    ).toThrow("extra is not part of the contract shape");
    expect(() =>
      assertStoredRun({
        ...kernelProtocolStoredFixtures.storedRun,
        extra: 1,
      })
    ).toThrow("extra is not part of the contract shape");
    expect(() =>
      assertStoredTurnNode({
        ...kernelProtocolStoredFixtures.storedTurnNode,
        extra: 1,
      })
    ).toThrow("extra is not part of the contract shape");
  });

  test("rejects schema-invalid change sets and duplicate staged-result taskIds", () => {
    expect(() =>
      assertTurnTreeChangeSet(
        { ghost: null },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow("ghost must reference a schema-defined path");
    expect(() =>
      assertTurnTreeChangeSet(
        {
          "context.manifest": [
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ],
        },
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow(
      "context.manifest must be a HashString or null for a single path"
    );
    expect(() =>
      assertTurnNode({
        ...kernelProtocolLogicalFixtures.turnNode,
        consumedStagedResults: [
          kernelProtocolLogicalFixtures.turnNode.consumedStagedResults[0],
          {
            ...kernelProtocolLogicalFixtures.turnNode.consumedStagedResults[0],
            objectHash:
              "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
          },
        ],
      })
    ).toThrow("must not contain duplicate staged result taskIds");
    expect(() =>
      assertStoredTurnNode({
        ...kernelProtocolStoredFixtures.storedTurnNode,
        consumedStagedResultsCbor: encodeDeterministicKernelRecord([
          kernelProtocolLogicalFixtures.turnNode.consumedStagedResults[0],
          {
            ...kernelProtocolLogicalFixtures.turnNode.consumedStagedResults[0],
            objectHash:
              "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
          },
        ]),
      })
    ).toThrow("must not contain duplicate staged result taskIds");
    expect(() =>
      assertRecoveryState({
        ...kernelProtocolLogicalFixtures.recoveryState,
        consumedStagedResults: [kernelProtocolLogicalFixtures.stagedResult],
        uncommittedStagedResults: [kernelProtocolLogicalFixtures.stagedResult],
      })
    ).toThrow("must not repeat taskIds already present");
  });
});

describe("stored contract fixtures", () => {
  test("accepts the canonical stored record fixtures", () => {
    const schema = kernelProtocolDeterministicFixtures.turnTreeSchemaRecord;

    expect(() =>
      assertStoredObject(kernelProtocolStoredFixtures.storedObject)
    ).not.toThrow();
    expect(() =>
      assertStoredSchema(kernelProtocolStoredFixtures.storedSchema)
    ).not.toThrow();
    expect(() =>
      assertStoredTurnTree(kernelProtocolStoredFixtures.storedTurnTree, schema)
    ).not.toThrow();
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolStoredFixtures.storedTurnTreePath,
        schema
      )
    ).not.toThrow();
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolStoredFixtures.storedTurnTreePathOrdered,
        schema
      )
    ).not.toThrow();
    expect(() =>
      assertStoredOrderedPathChunk(
        kernelProtocolStoredFixtures.storedOrderedPathChunk
      )
    ).not.toThrow();
    expect(() =>
      assertStoredTurnNode(kernelProtocolStoredFixtures.storedTurnNode)
    ).not.toThrow();
    expect(() =>
      assertStoredThread(kernelProtocolStoredFixtures.storedThread)
    ).not.toThrow();
    expect(() =>
      assertStoredBranch(kernelProtocolStoredFixtures.storedBranch)
    ).not.toThrow();
    expect(() =>
      assertStoredTurn(kernelProtocolStoredFixtures.storedTurn)
    ).not.toThrow();
    expect(() =>
      assertStoredRun(kernelProtocolStoredFixtures.storedRun)
    ).not.toThrow();
    expect(() =>
      assertStoredStagedResult(kernelProtocolStoredFixtures.storedStagedResult)
    ).not.toThrow();
  });

  test("rejects stored objects whose byteLength disagrees with bytes", () => {
    expect(() =>
      assertStoredObject(
        kernelProtocolInvalidFixtures.invalidStoredObjectByteLength
      )
    ).toThrow("byteLength must match");
  });

  test("enforces content-addressed identity for stored objects, chunk refs, turn nodes, and turn trees", async () => {
    const schema = kernelProtocolDeterministicFixtures.turnTreeSchemaRecord;

    await expect(
      assertStoredObjectIdentity(kernelProtocolStoredFixtures.storedObject)
    ).resolves.toBeUndefined();
    await expect(
      assertStoredOrderedPathChunkIdentity(
        kernelProtocolStoredFixtures.storedOrderedPathChunk
      )
    ).resolves.toBeUndefined();
    await expect(
      assertStoredTurnNodeIdentity(kernelProtocolStoredFixtures.storedTurnNode)
    ).resolves.toBeUndefined();
    await expect(
      assertStoredTurnTreeIdentity(
        kernelProtocolStoredFixtures.storedTurnTree,
        schema
      )
    ).resolves.toBeUndefined();
    await expect(
      assertStoredTurnTreeIdentity(
        {
          ...kernelProtocolStoredFixtures.storedTurnTree,
          schemaId: "schema_other",
        },
        schema
      )
    ).rejects.toThrow("schemaId must match schema.schemaId");
    await expect(
      assertStoredObjectIdentity(
        kernelProtocolInvalidFixtures.invalidStoredObjectMismatchedHash
      )
    ).rejects.toThrow("hash must match the SHA-256 digest");
    await expect(
      assertStoredOrderedPathChunkIdentity(
        kernelProtocolInvalidFixtures.invalidStoredOrderedPathChunkMismatchedHash
      )
    ).rejects.toThrow("chunkHash must match the deterministic hash");
    await expect(
      assertStoredTurnNodeIdentity(
        kernelProtocolInvalidFixtures.invalidStoredTurnNodeMismatchedHash
      )
    ).rejects.toThrow("hash must match the canonical TurnNode identity hash");
    await expect(
      assertStoredTurnTreeIdentity(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreeMismatchedHash,
        schema
      )
    ).rejects.toThrow("hash must match the deterministic hash");
  });

  test("rejects manifests and stored TurnTree rows that do not match the active schema", async () => {
    const schema = kernelProtocolDeterministicFixtures.turnTreeSchemaRecord;
    const partialManifest = {
      messages: [],
    };
    const invalidManifest = {
      "context.manifest":
        "2222222222222222222222222222222222222222222222222222222222222222",
      ghost: [],
      messages: [],
    };

    expect(() => assertTurnTreeManifest(partialManifest, schema)).toThrow(
      "context.manifest must be present in a full TurnTree manifest"
    );
    expect(() => assertTurnTreeManifest(invalidManifest, schema)).toThrow(
      "must reference a schema-defined path"
    );
    expect(() =>
      assertStoredTurnTree(
        {
          ...kernelProtocolStoredFixtures.storedTurnTree,
          manifestCbor: encodeDeterministicKernelRecord(
            invalidManifest as never
          ),
        },
        schema
      )
    ).toThrow("must reference a schema-defined path");
    await expect(
      assertStoredTurnTreeIdentity(
        {
          ...kernelProtocolStoredFixtures.storedTurnTree,
          manifestCbor: encodeDeterministicKernelRecord(
            invalidManifest as never
          ),
        },
        schema
      )
    ).rejects.toThrow("must reference a schema-defined path");
    expect(() =>
      assertStoredTurnTreePath(
        {
          collectionKind: "ordered",
          orderedCount: 1,
          orderedEncoding: "flat",
          orderedInlineCbor: encodeDeterministicKernelRecord([
            "2222222222222222222222222222222222222222222222222222222222222222",
          ]),
          path: "context.manifest",
          turnTreeHash:
            "3636363636363636363636363636363636363636363636363636363636363636",
        },
        schema
      )
    ).toThrow("collectionKind must match the schema collection");
  });

  test("rejects partial manifests when validating against a full schema", async () => {
    const schema = kernelProtocolDeterministicFixtures.turnTreeSchemaRecord;
    const partialManifest = {
      messages: [],
    };

    expect(() => assertTurnTreeManifest(partialManifest, schema)).toThrow(
      "context.manifest must be present in a full TurnTree manifest"
    );
    expect(() =>
      assertStoredTurnTree(
        {
          ...kernelProtocolStoredFixtures.storedTurnTree,
          manifestCbor: encodeDeterministicKernelRecord(
            partialManifest as never
          ),
        },
        schema
      )
    ).toThrow("context.manifest must be present in a full TurnTree manifest");
    await expect(
      assertStoredTurnTreeIdentity(
        {
          ...kernelProtocolStoredFixtures.storedTurnTree,
          manifestCbor: encodeDeterministicKernelRecord(
            partialManifest as never
          ),
        },
        schema
      )
    ).rejects.toThrow(
      "context.manifest must be present in a full TurnTree manifest"
    );
    expect(() =>
      hashTurnTreeIdentity("schema_main", partialManifest as never, schema)
    ).toThrow("context.manifest must be present in a full TurnTree manifest");
  });

  test("rejects stored runs whose decoded step sequence or created nodes are invalid", () => {
    expect(() =>
      assertStoredRun(
        kernelProtocolInvalidFixtures.invalidStoredRunPastStepSequence
      )
    ).toThrow("currentStepIndex must not exceed the decoded step count");
    expect(() =>
      assertStoredRun(
        kernelProtocolInvalidFixtures.invalidStoredCompletedRunBeforeSequenceEnd
      )
    ).toThrow(
      'must equal the declared step count in value.stepSequenceCbor when value.status is "completed"'
    );
    expect(() =>
      assertStoredRun(
        kernelProtocolInvalidFixtures.invalidStoredRunWithMalformedCreatedTurnNodesCbor
      )
    ).toThrow("createdTurnNodesCbor");
  });

  test("rejects stored schemas whose top-level id disagrees with schemaCbor", () => {
    expect(() =>
      assertStoredSchema(
        kernelProtocolInvalidFixtures.invalidStoredSchemaMismatchedSchemaId
      )
    ).toThrow("schemaId must match the decoded schemaId");
  });

  test("rejects impossible stored turn-tree path combinations", () => {
    const schema = kernelProtocolDeterministicFixtures.turnTreeSchemaRecord;

    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathSingleWithOrderedFields,
        schema
      )
    ).toThrow(
      'must not include ordered-path fields when collectionKind is "single"'
    );
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathWithOrderedSingleHash,
        schema
      )
    ).toThrow('singleHash must be omitted when collectionKind is "ordered"');
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathMissingOrderedPayload,
        schema
      )
    ).toThrow('orderedInlineCbor is required when orderedEncoding is "flat"');
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathWithWrongEncodingPayload,
        schema
      )
    ).toThrow(
      'orderedChunkListCbor must be omitted when orderedEncoding is "flat"'
    );
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathChunkedWithoutChunkRefs,
        schema
      )
    ).toThrow("must contain at least one chunk");
    expect(() =>
      assertStoredTurnTreePath(
        {
          collectionKind: "ordered",
          orderedChunkListCbor: encodeDeterministicKernelRecord([]),
          orderedCount: 0,
          orderedEncoding: "chunked",
          path: "messages",
          turnTreeHash:
            "5858585858585858585858585858585858585858585858585858585858585858",
        },
        schema
      )
    ).toThrow("must use flat ordered storage");
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathWithMalformedPath,
        schema
      )
    ).toThrow("must be a dot-separated path with non-empty segments");
  });

  test("rejects stored ordered payloads whose decoded cardinality disagrees", () => {
    const schema = kernelProtocolDeterministicFixtures.turnTreeSchemaRecord;

    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathOrderedCountMismatch,
        schema
      )
    ).toThrow("orderedCount must match the decoded item count");
    expect(() =>
      assertStoredOrderedPathChunk(
        kernelProtocolInvalidFixtures.invalidStoredOrderedPathChunkCountMismatch
      )
    ).toThrow("itemCount must match the decoded item count");
  });

  test("rejects contradictory interrupt payloads", () => {
    expect(() =>
      assertStagedResult(
        kernelProtocolInvalidFixtures.invalidStagedResultWithCompletedInterruptPayload
      )
    ).toThrow(
      'interruptPayload must be omitted unless status is "interrupted"'
    );
    expect(() =>
      assertStoredStagedResult(
        kernelProtocolInvalidFixtures.invalidStoredStagedResultWithCompletedInterruptPayload
      )
    ).toThrow(
      'interruptPayloadCbor must be omitted unless status is "interrupted"'
    );
    expect(() =>
      assertStagedResult({
        ...kernelProtocolInvalidFixtures.invalidStagedResultWithCompletedInterruptPayload,
        interruptPayload: undefined,
        status: "interrupted",
      })
    ).toThrow("interruptPayload must be omitted instead of undefined");
    expect(() =>
      assertStoredStagedResult({
        ...kernelProtocolInvalidFixtures.invalidStoredStagedResultWithCompletedInterruptPayload,
        interruptPayloadCbor: undefined,
        status: "interrupted",
      })
    ).toThrow("interruptPayloadCbor must be omitted instead of undefined");
  });

  test("rejects explicit undefined for optional stored fields", () => {
    expect(() =>
      assertStoredStagedResult({
        ...kernelProtocolStoredFixtures.storedStagedResult,
        interruptPayloadCbor: undefined,
      })
    ).toThrow("interruptPayloadCbor must be omitted instead of undefined");
    expect(() =>
      assertStoredBranch({
        ...kernelProtocolStoredFixtures.storedBranch,
        archivedFromBranchId: undefined,
      })
    ).toThrow("archivedFromBranchId must be omitted instead of undefined");
    expect(() =>
      assertStoredTurnTreePath({
        ...kernelProtocolStoredFixtures.storedTurnTreePath,
        singleHash: undefined,
      })
    ).toThrow("singleHash must be omitted instead of undefined");
    expect(() =>
      assertStoredTurnTreePath({
        collectionKind: "single",
        path: "context.manifest",
        turnTreeHash:
          "98d7b1f35f6ebf506508b1bfbd6be173147a80bc85917a17756c66d97faf8b87",
      })
    ).toThrow('singleHash is required when collectionKind is "single"');
  });

  test("rejects time-regressing and self-referential stored lifecycle rows", () => {
    expect(() =>
      assertStoredBranch({
        ...kernelProtocolStoredFixtures.storedBranch,
        archivedFromBranchId:
          kernelProtocolStoredFixtures.storedBranch.branchId,
      })
    ).toThrow("archivedFromBranchId must differ from value.branchId");
    expect(() =>
      assertStoredBranch({
        ...kernelProtocolStoredFixtures.storedBranch,
        updatedAtMs: kernelProtocolStoredFixtures.storedBranch.createdAtMs - 1,
      })
    ).toThrow("updatedAtMs must be greater than or equal to value.createdAtMs");
    expect(() =>
      assertStoredTurn({
        ...kernelProtocolStoredFixtures.storedTurn,
        updatedAtMs: kernelProtocolStoredFixtures.storedTurn.createdAtMs - 1,
      })
    ).toThrow("updatedAtMs must be greater than or equal to value.createdAtMs");
    expect(() =>
      assertStoredRun({
        ...kernelProtocolStoredFixtures.storedRun,
        updatedAtMs: kernelProtocolStoredFixtures.storedRun.createdAtMs - 1,
      })
    ).toThrow("updatedAtMs must be greater than or equal to value.createdAtMs");
  });

  test("rejects malformed stored CBOR payloads for core records", () => {
    expect(() =>
      assertStoredSchema(
        kernelProtocolInvalidFixtures.invalidStoredSchemaMalformedCbor
      )
    ).toThrow("schemaCbor");
    expect(() =>
      assertStoredTurnTree(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreeMalformedManifestCbor,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toThrow("manifestCbor");
    expect(() =>
      assertStoredTurnNode(
        kernelProtocolInvalidFixtures.invalidStoredTurnNodeMalformedConsumedStagedResultsCbor
      )
    ).toThrow("consumedStagedResultsCbor");
    expect(() =>
      assertStoredStagedResult(
        kernelProtocolInvalidFixtures.invalidStoredStagedResultWithMalformedInterruptPayloadCbor
      )
    ).toThrow("interruptPayloadCbor");
  });
});
