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
import { KrakenValidationError } from "@kraken/shared-core-types";
import {
  kernelProtocolDeterministicFixtures,
  kernelProtocolInvalidFixtures,
  kernelProtocolLogicalFixtures,
  kernelProtocolStoredFixtures,
} from "../../../../../tests/fixtures/kernel-protocol-fixtures.js";
import { deterministicKernelRecordFixture } from "../../../../../tests/fixtures/kernel-record-fixtures.js";
import {
  assertBranchHeadListEntry,
  assertBranchRecord,
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
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  isBranchHeadListEntry,
  isObserveResult,
  isRunStatus,
  isStagedResultStatus,
} from "../src/index.ts";

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

  test("wraps malformed deterministic CBOR bytes in KrakenValidationError", () => {
    let caughtError: unknown;

    try {
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidTruncatedKernelRecordBytes
      );
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(KrakenValidationError);
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain(
      "must contain valid deterministic CBOR"
    );
  });

  test("rejects malformed TurnNode identity inputs with KrakenValidationError", async () => {
    await expect(
      hashTurnNodeIdentity(undefined as never)
    ).rejects.toBeInstanceOf(KrakenValidationError);
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
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord(
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ).toString("hex");
    const digestHex = await hashKernelRecord(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
    );

    expect(encodedHex).toBe(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex
    );
    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecordSha256Hex
    );
  });

  test("locks the canonical TurnNode identity-preimage bytes and digest", async () => {
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord(
        kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
      )
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

  test("hashes opaque object bytes without structured-record canonicalization", async () => {
    const digestHex = await hashOpaqueObjectBytes(
      kernelProtocolDeterministicFixtures.rawOpaqueBytes
    );

    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.rawOpaqueBytesSha256Hex
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
      assertTurnTreeChangeSet({
        "messages..results":
          "5858585858585858585858585858585858585858585858585858585858585858",
      })
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
  });

  test("does not accept required fields inherited from Object.prototype", () => {
    const originalSchemaId = Object.prototype.schemaId;
    const originalPaths = Object.prototype.paths;
    const originalIncorporationRules = Object.prototype.incorporationRules;
    const originalId = Object.prototype.id;
    const originalDeterministic = Object.prototype.deterministic;
    const originalSideEffects = Object.prototype.sideEffects;
    const hadSchemaId = Object.hasOwn(Object.prototype, "schemaId");
    const hadPaths = Object.hasOwn(Object.prototype, "paths");
    const hadIncorporationRules = Object.hasOwn(
      Object.prototype,
      "incorporationRules"
    );
    const hadId = Object.hasOwn(Object.prototype, "id");
    const hadDeterministic = Object.hasOwn(Object.prototype, "deterministic");
    const hadSideEffects = Object.hasOwn(Object.prototype, "sideEffects");

    Object.prototype.schemaId = "schema_main";
    Object.prototype.paths = [{ path: "messages", collection: "ordered" }];
    Object.prototype.incorporationRules = [];
    Object.prototype.id = "model_call";
    Object.prototype.deterministic = false;
    Object.prototype.sideEffects = false;

    try {
      expect(() => assertTurnTreeSchema({})).toThrow(
        "schemaId must be a non-empty string"
      );
      expect(() => assertStepDeclaration({})).toThrow(
        "id must be a non-empty string"
      );
    } finally {
      restorePrototypeValue(
        Object.prototype,
        "schemaId",
        hadSchemaId,
        originalSchemaId
      );
      restorePrototypeValue(Object.prototype, "paths", hadPaths, originalPaths);
      restorePrototypeValue(
        Object.prototype,
        "incorporationRules",
        hadIncorporationRules,
        originalIncorporationRules
      );
      restorePrototypeValue(Object.prototype, "id", hadId, originalId);
      restorePrototypeValue(
        Object.prototype,
        "deterministic",
        hadDeterministic,
        originalDeterministic
      );
      restorePrototypeValue(
        Object.prototype,
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
        kernelProtocolLogicalFixtures.turnTreeChangeSet.context_manifest,
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
      assertTurnTreeChangeSet(kernelProtocolLogicalFixtures.turnTreeChangeSet)
    ).not.toThrow();
    expect(() =>
      assertObserveResult(kernelProtocolLogicalFixtures.observeResult)
    ).not.toThrow();
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
});

describe("stored contract fixtures", () => {
  test("accepts the canonical stored record fixtures", () => {
    expect(() =>
      assertStoredObject(kernelProtocolStoredFixtures.storedObject)
    ).not.toThrow();
    expect(() =>
      assertStoredSchema(kernelProtocolStoredFixtures.storedSchema)
    ).not.toThrow();
    expect(() =>
      assertStoredTurnTree(kernelProtocolStoredFixtures.storedTurnTree)
    ).not.toThrow();
    expect(() =>
      assertStoredTurnTreePath(kernelProtocolStoredFixtures.storedTurnTreePath)
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
      assertStoredTurnTreeIdentity(kernelProtocolStoredFixtures.storedTurnTree)
    ).resolves.toBeUndefined();
    await expect(
      assertStoredTurnTreeIdentity({
        ...kernelProtocolStoredFixtures.storedTurnTree,
        schemaId: "schema_other",
      })
    ).rejects.toThrow(
      "hash must match the deterministic hash of value.schemaId and value.manifestCbor"
    );
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
        kernelProtocolInvalidFixtures.invalidStoredTurnTreeMismatchedHash
      )
    ).rejects.toThrow("hash must match the deterministic hash");
  });

  test("rejects stored runs whose decoded step sequence or created nodes are invalid", () => {
    expect(() =>
      assertStoredRun(
        kernelProtocolInvalidFixtures.invalidStoredRunPastStepSequence
      )
    ).toThrow("currentStepIndex must not exceed the decoded step count");
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
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathSingleWithOrderedFields
      )
    ).toThrow(
      'must not include ordered-path fields when collectionKind is "single"'
    );
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathWithOrderedSingleHash
      )
    ).toThrow('singleHash must be omitted when collectionKind is "ordered"');
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathMissingOrderedPayload
      )
    ).toThrow('orderedInlineCbor is required when orderedEncoding is "flat"');
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathWithWrongEncodingPayload
      )
    ).toThrow(
      'orderedChunkListCbor must be omitted when orderedEncoding is "flat"'
    );
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathChunkedWithoutChunkRefs
      )
    ).toThrow("must contain at least one chunk");
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathWithMalformedPath
      )
    ).toThrow("must be a dot-separated path with non-empty segments");
  });

  test("rejects stored ordered payloads whose decoded cardinality disagrees", () => {
    expect(() =>
      assertStoredTurnTreePath(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreePathOrderedCountMismatch
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
        orderedInlineCbor: undefined,
      })
    ).toThrow("orderedInlineCbor must be omitted instead of undefined");
  });

  test("rejects malformed stored CBOR payloads for core records", () => {
    expect(() =>
      assertStoredSchema(
        kernelProtocolInvalidFixtures.invalidStoredSchemaMalformedCbor
      )
    ).toThrow("schemaCbor");
    expect(() =>
      assertStoredTurnTree(
        kernelProtocolInvalidFixtures.invalidStoredTurnTreeMalformedManifestCbor
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
