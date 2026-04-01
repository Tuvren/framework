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
  kernelProtocolDeterministicFixtures,
  kernelProtocolInvalidFixtures,
  kernelProtocolLogicalFixtures,
  kernelProtocolStoredFixtures,
} from "../../../../../tests/fixtures/kernel-protocol-fixtures.js";
import { deterministicKernelRecordFixture } from "../../../../../tests/fixtures/kernel-record-fixtures.js";
import {
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
  assertStoredBranch,
  assertStoredObject,
  assertStoredOrderedPathChunk,
  assertStoredRun,
  assertStoredSchema,
  assertStoredStagedResult,
  assertStoredThread,
  assertStoredTurn,
  assertStoredTurnNode,
  assertStoredTurnTree,
  assertStoredTurnTreePath,
  assertThreadCreateResult,
  assertThreadRecord,
  assertTurnNode,
  assertTurnRecord,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
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

  test("rejects non-canonical deterministic CBOR encodings on decode", () => {
    expect(() =>
      decodeDeterministicKernelRecord(
        kernelProtocolInvalidFixtures.invalidNonCanonicalKernelRecordBytes
      )
    ).toThrow("must already use the canonical deterministic CBOR encoding");
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

  test("locks the canonical TurnNode bytes and hash", async () => {
    const encodedHex = Buffer.from(
      encodeDeterministicKernelRecord(
        kernelProtocolDeterministicFixtures.turnNodeRecord
      )
    ).toString("hex");
    const digestHex = await hashKernelRecord(
      kernelProtocolDeterministicFixtures.turnNodeRecord
    );

    expect(encodedHex).toBe(
      kernelProtocolDeterministicFixtures.turnNodeRecordCborHex
    );
    expect(digestHex).toBe(
      kernelProtocolDeterministicFixtures.turnNodeRecordSha256Hex
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
});

describe("logical contract fixtures", () => {
  test("accepts the canonical logical record fixtures", () => {
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

  test("exposes status guards for runtime callers", () => {
    expect(isRunStatus("running")).toBe(true);
    expect(isRunStatus("broken")).toBe(false);
    expect(isStagedResultStatus("completed")).toBe(true);
    expect(isStagedResultStatus("unknown")).toBe(false);
    expect(() => assertRunStatus("paused")).not.toThrow();
    expect(() => assertStagedResultStatus("interrupted")).not.toThrow();
  });

  test("rejects invalid observe annotations", () => {
    expect(
      isObserveResult(kernelProtocolInvalidFixtures.invalidObserveResult)
    ).toBe(false);
    expect(() =>
      assertObserveResult(kernelProtocolInvalidFixtures.invalidObserveResult)
    ).toThrow(
      "annotations[0] must be a lowercase 64-character SHA-256 hex digest"
    );
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
    ).toThrow('interruptPayload is required when status is "interrupted"');
    expect(() =>
      assertStoredStagedResult({
        ...kernelProtocolInvalidFixtures.invalidStoredStagedResultWithCompletedInterruptPayload,
        interruptPayloadCbor: undefined,
        status: "interrupted",
      })
    ).toThrow('interruptPayloadCbor is required when status is "interrupted"');
  });
});
