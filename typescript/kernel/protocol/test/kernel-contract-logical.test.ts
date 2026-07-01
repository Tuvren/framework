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
import type { ComposedVerdict, KernelSignal, Verdict } from "../src/index.ts";
import {
  assertBranchHeadListEntry,
  assertBranchRecord,
  assertComposedVerdict,
  assertObserveResult,
  assertRecoveryState,
  assertRunRecord,
  assertRunStatus,
  assertSetHeadResult,
  assertStagedResult,
  assertStagedResultStatus,
  assertStepContext,
  assertStepDeclaration,
  assertStoredObject,
  assertStoredRun,
  assertStoredTurnNode,
  assertThreadCreateResult,
  assertThreadRecord,
  assertTurnNode,
  assertTurnNodeIdentity,
  assertTurnRecord,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  assertVerdict,
  assertVerdictDisposition,
  encodeDeterministicKernelRecord,
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
    ).not.toThrow();
    expect(() =>
      assertStoredRun(
        kernelProtocolInvalidFixtures.invalidStoredRunningRunAtSequenceEnd
      )
    ).not.toThrow();
    expect(() =>
      assertRunRecord({
        ...kernelProtocolInvalidFixtures.invalidRunningRunRecordAtSequenceEnd,
        currentStepIndex: 2,
      })
    ).toThrow("currentStepIndex must not exceed value.stepSequence.length");
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
