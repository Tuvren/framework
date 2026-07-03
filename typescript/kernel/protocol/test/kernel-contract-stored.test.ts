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
import {
  assertStagedResult,
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
  assertTurnTreeManifest,
  encodeDeterministicKernelRecord,
  hashTurnTreeIdentity,
} from "../src/index.ts";
import {
  kernelProtocolDeterministicFixtures,
  kernelProtocolInvalidFixtures,
  kernelProtocolStoredFixtures,
} from "./kernel-protocol-fixtures.js";

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
