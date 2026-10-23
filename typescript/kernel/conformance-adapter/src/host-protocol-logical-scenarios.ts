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

import {
  assertStagedResult,
  assertVerdict,
  hashKernelRecord,
  hashTurnNodeIdentity,
} from "@tuvren/kernel-protocol";
import type { StagedResult, Verdict } from "@tuvren/kernel-protocol";
import type { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type { KernelMutantCodec } from "@tuvren/kernel-testkit";

import { createProjection } from "./host-scenario-support.js";
import type { KernelAdapterConfig } from "./host-scenario-support.js";
import {
  conformanceCodec,
  hexToBytes,
  loadCanonicalSchema,
  normalizeLogicalErrorCode,
  readErrorCode,
  readFixture,
  readFixtureOptional,
  readLogicalFixture,
  readRecord,
  readString,
  stageFixtureResult,
  withConformanceKernel,
} from "./host-support.js";

const readVerdicts = (value: unknown, caseName: string): Verdict[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`cases.${caseName}.verdicts must be an array`);
  }

  return value.map((entry, index) => {
    assertVerdict(entry, `cases.${caseName}.verdicts[${index}]`);
    return entry;
  });
};

const captureSemanticErrorCode = async (
  execute: () => Promise<unknown>
): Promise<string> => {
  try {
    await execute();
    return "unexpected_success";
  } catch (error: unknown) {
    return normalizeLogicalErrorCode(readErrorCode(error));
  }
};

const schemaRoundtrip = (
  codec: KernelMutantCodec,
  fixture: Record<string, unknown>
): Record<string, unknown> =>
  createProjection({
    roundtrip: {
      turnNodeIdentityRecord: codec.decodeDeterministicKernelRecord(
        hexToBytes(
          readString(
            fixture.turnNodeIdentityRecordCborHex,
            "turnNodeIdentityRecordCborHex"
          )
        )
      ),
      turnTreeSchemaRecord: codec.decodeDeterministicKernelRecord(
        hexToBytes(
          readString(
            fixture.turnTreeSchemaRecordCborHex,
            "turnTreeSchemaRecordCborHex"
          )
        )
      ),
    },
  });

const composeVerdictCases = async (
  kernel: ReturnType<typeof createRuntimeKernel>,
  entries: readonly [string, unknown][],
  composition: Record<string, unknown> = {},
  index = 0
): Promise<Record<string, unknown>> => {
  const entry = entries[index];
  if (entry === undefined) {
    return composition;
  }

  const [caseName, caseValue] = entry;
  const caseRecord = readRecord(caseValue, `cases.${caseName}`);
  const verdicts = readVerdicts(caseRecord.verdicts, caseName);
  composition[caseName] = await kernel.verdicts.compose(verdicts);

  return await composeVerdictCases(kernel, entries, composition, index + 1);
};

const stageFixtureResults = async (
  kernel: ReturnType<typeof createRuntimeKernel>,
  runId: string,
  stagedResults: readonly StagedResult[],
  index = 0
): Promise<void> => {
  const stagedResult = stagedResults[index];
  if (stagedResult === undefined) {
    return;
  }

  await stageFixtureResult(kernel, runId, stagedResult, index);
  await stageFixtureResults(kernel, runId, stagedResults, index + 1);
};

const readStagedResults = (value: unknown, label: string): StagedResult[] => {
  const results = Array.isArray(value)
    ? value
    : (() => {
        throw new Error(`${label} must be an array`);
      })();
  const stagedResults: StagedResult[] = [];

  for (const [index, stagedResult] of results.entries()) {
    assertStagedResult(stagedResult, `${label}[${index}]`);
    stagedResults.push(stagedResult);
  }

  return stagedResults;
};

const readNumberArray = (value: unknown, label: string): number[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  const values = value;

  if (!values.every((entry) => typeof entry === "number")) {
    throw new Error(`${label} must contain numbers`);
  }

  return values;
};

const runCanonicalRejection = (
  codec: KernelMutantCodec,
  fixture: Record<string, unknown>
): Record<string, unknown> => {
  const cases = readRecord(fixture.cases, "cases");
  const rejection: Record<string, unknown> = {};

  for (const [caseName, caseValue] of Object.entries(cases)) {
    const caseRecord = readRecord(caseValue, `cases.${caseName}`);
    const cborBytes = readNumberArray(
      caseRecord.cborBytes,
      `cases.${caseName}.cborBytes`
    );

    let rejected: boolean;
    try {
      codec.decodeDeterministicKernelRecord(Uint8Array.from(cborBytes));
      rejected = false;
    } catch {
      rejected = true;
    }

    rejection[caseName] = { rejected };
  }

  return createProjection({ rejection });
};

const readNullableString = (value: unknown, label: string): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  return value;
};

const deterministicHashing = async (
  codec: KernelMutantCodec,
  input: unknown
): Promise<Record<string, unknown>> => {
  const fixture = readFixture(input);
  const rawOpaqueBytes = readNumberArray(
    fixture.rawOpaqueBytes,
    "rawOpaqueBytes"
  );
  const schemaRecord = codec.decodeDeterministicKernelRecord(
    hexToBytes(readString(fixture.turnTreeSchemaRecordCborHex, "schema cbor"))
  );
  const turnNodeIdentityRecord = readRecord(
    fixture.turnNodeIdentityRecord,
    "turnNodeIdentityRecord"
  );
  const turnNodeHash = await hashTurnNodeIdentity({
    consumedStagedResults: readStagedResults(
      turnNodeIdentityRecord.consumedStagedResults,
      "consumedStagedResults"
    ),
    eventHash: readNullableString(
      turnNodeIdentityRecord.eventHash,
      "eventHash"
    ),
    previousTurnNodeHash: readNullableString(
      turnNodeIdentityRecord.previousTurnNodeHash,
      "previousTurnNodeHash"
    ),
    schemaId: readString(turnNodeIdentityRecord.schemaId, "schemaId"),
    turnTreeHash: readString(
      turnNodeIdentityRecord.turnTreeHash,
      "turnTreeHash"
    ),
  });

  return createProjection({
    hashes: {
      rawOpaqueBytes: await codec.hashOpaqueObjectBytes(
        Uint8Array.from(rawOpaqueBytes)
      ),
      turnNodeIdentity: turnNodeHash,
      turnTreeSchema: await hashKernelRecord(schemaRecord),
    },
  });
};

const readProtocolFixture = (input: unknown): Record<string, unknown> =>
  readFixture(input);

export const createProtocolLogicalScenarios = (config: KernelAdapterConfig) => {
  const codec = conformanceCodec(config);

  const runModifyComposition = async (
    input: unknown
  ): Promise<Record<string, unknown>> => {
    const fixture = readFixtureOptional(input);

    if (fixture === undefined) {
      const schema = await loadCanonicalSchema();
      return await withConformanceKernel(schema, config, async (kernel) => {
        const verdict = await kernel.verdicts.compose([
          {
            kind: "modify",
            transform: { extension: "first", mutation: "append-prefix" },
          },
          { kind: "proceed" },
          {
            kind: "modify",
            transform: { extension: "second", mutation: "append-suffix" },
          },
        ]);

        if (verdict.kind !== "modify") {
          throw new Error(
            `expected composed modify verdict, received ${verdict.kind}`
          );
        }

        return createProjection({
          verdict: {
            kind: verdict.kind,
            transform: verdict.transform,
          },
        });
      });
    }

    const cases = readRecord(fixture.cases, "cases");
    const schema = await loadCanonicalSchema();
    return await withConformanceKernel(schema, config, async (kernel) => {
      const composition = await composeVerdictCases(
        kernel,
        Object.entries(cases)
      );

      return createProjection({ composition });
    });
  };

  const runLogicalDiff = async (
    input: unknown
  ): Promise<Record<string, unknown>> => {
    const fixture = readFixture(input);
    const schema = await loadCanonicalSchema();
    const logical = readLogicalFixture(fixture, schema);
    return await withConformanceKernel(schema, config, async (kernel) => {
      const created = await kernel.thread.create(
        "thread_conformance",
        schema.schemaId,
        logical.branchHeadListEntry[0]
      );
      const changedTree = await kernel.tree.create(
        schema.schemaId,
        logical.turnTreeChangeSet,
        created.rootTurnTreeHash
      );
      const changedPaths = await kernel.tree.diff(
        created.rootTurnTreeHash,
        changedTree
      );
      const diffPaths = changedPaths.toSorted();

      return createProjection({ diffPaths });
    });
  };

  const runBranchList = async (
    input: unknown
  ): Promise<Record<string, unknown>> => {
    const fixture = readFixture(input);
    const schema = await loadCanonicalSchema();
    const logical = readLogicalFixture(fixture, schema);
    return await withConformanceKernel(schema, config, async (kernel) => {
      await kernel.thread.create(
        "thread_conformance",
        schema.schemaId,
        logical.branchHeadListEntry[0]
      );
      const branchEntries = await kernel.branch.list("thread_conformance");

      return createProjection({ branchEntries });
    });
  };

  const runThreadList = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();
    return await withConformanceKernel(schema, config, async (kernel) => {
      await kernel.thread.create(
        "thread_enum_a",
        schema.schemaId,
        "branch_enum_a"
      );
      await kernel.thread.create(
        "thread_enum_b",
        schema.schemaId,
        "branch_enum_b"
      );
      const { threads: allThreads } = await kernel.thread.list();
      const { threads: pagedThreads, nextCursor } = await kernel.thread.list({
        limit: 1,
      });
      return createProjection({
        threadEnumeration: {
          count: allThreads.length,
          firstThreadId: allThreads[0]?.threadId ?? null,
          hasCursor: nextCursor !== undefined,
          pagedCount: pagedThreads.length,
        },
      });
    });
  };

  const runRecoveryState = async (
    input: unknown
  ): Promise<Record<string, unknown>> => {
    const fixture = readFixture(input);
    const schema = await loadCanonicalSchema();
    const logical = readLogicalFixture(fixture, schema);
    return await withConformanceKernel(schema, config, async (kernel) => {
      const thread = await kernel.thread.create(
        "thread_conformance",
        schema.schemaId,
        logical.branchHeadListEntry[0]
      );
      const turn = await kernel.turn.create(
        "turn_recovery",
        thread.threadId,
        thread.branchId,
        null,
        thread.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_recovery",
        turn.turnId,
        thread.branchId,
        schema.schemaId,
        thread.rootTurnNodeHash,
        logical.recoveryState.stepSequence
      );

      const [firstStep, secondStep] = logical.recoveryState.stepSequence;

      if (firstStep === undefined || secondStep === undefined) {
        throw new Error(
          "logical recovery fixture must declare at least two steps"
        );
      }

      await kernel.run.beginStep("run_recovery", firstStep.id);
      await kernel.run.completeStep("run_recovery", firstStep.id);
      await kernel.run.beginStep("run_recovery", secondStep.id);

      await stageFixtureResults(
        kernel,
        "run_recovery",
        logical.recoveryState.consumedStagedResults
      );

      await kernel.run.completeStep("run_recovery", secondStep.id);

      await stageFixtureResults(
        kernel,
        "run_recovery",
        logical.recoveryState.uncommittedStagedResults
      );

      const recovery = await kernel.run.recover("run_recovery");

      return createProjection({
        recovery: {
          consumedStagedResults: recovery.consumedStagedResults.length,
          lastCompletedStepId: recovery.lastCompletedStepId,
          uncommittedStagedResults: recovery.uncommittedStagedResults.length,
        },
      });
    });
  };

  const runCrossThreadLineage = async (): Promise<Record<string, unknown>> => {
    const schema = await loadCanonicalSchema();
    return await withConformanceKernel(schema, config, async (kernel) => {
      const threadA = await kernel.thread.create(
        "thread_a",
        schema.schemaId,
        "branch_a"
      );
      const turnA = await kernel.turn.create(
        "turn_a",
        threadA.threadId,
        threadA.branchId,
        null,
        threadA.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_a",
        turnA.turnId,
        threadA.branchId,
        schema.schemaId,
        threadA.rootTurnNodeHash,
        [{ deterministic: false, id: "step_a", sideEffects: false }]
      );
      const completed = await kernel.run.completeStep("run_a", "step_a");

      if (completed.turnNodeHash === undefined) {
        throw new Error(
          "expected checkpoint hash for cross-thread lineage check"
        );
      }

      await kernel.thread.create("thread_b", schema.schemaId, "branch_b");

      try {
        await kernel.branch.create(
          "branch_cross_thread",
          "thread_b",
          completed.turnNodeHash
        );

        // Unexpected acceptance is surfaced as evidence instead of crashing the
        // adapter so the shared runner can report one semantic failure cleanly.
        return createProjection({
          diagnostics: ["thread A node unexpectedly seeded thread B branch"],
          errorCode: "unexpected_success",
        });
      } catch (error: unknown) {
        return createProjection({
          errorCode: normalizeLogicalErrorCode(readErrorCode(error)),
        });
      }
    });
  };

  const runProtocolEdgeValidation = async (): Promise<
    Record<string, unknown>
  > => {
    const schema = await loadCanonicalSchema();
    return await withConformanceKernel(schema, config, async (kernel) => {
      const [firstPath] = schema.paths;

      if (firstPath === undefined) {
        throw new Error("canonical schema must define at least one path");
      }

      const duplicatePathCode = await captureSemanticErrorCode(async () => {
        await kernel.schema.register({
          ...schema,
          paths: [...schema.paths, { ...firstPath }],
          schemaId: "schema_edge_duplicate_path",
        });
      });

      const missingRequiredPathCode = await captureSemanticErrorCode(
        async () => {
          await kernel.tree.create(schema.schemaId, { messages: [] });
        }
      );

      const alternateSchema = {
        ...schema,
        schemaId: "schema_edge_alternate",
      };
      await kernel.schema.register(alternateSchema);
      const canonicalTree = await kernel.tree.create(schema.schemaId, {
        "context.manifest": null,
        messages: [],
      });
      const alternateTree = await kernel.tree.create(alternateSchema.schemaId, {
        "context.manifest": null,
        messages: [],
      });
      const schemaMismatchCode = await captureSemanticErrorCode(async () => {
        await kernel.tree.diff(canonicalTree, alternateTree);
      });

      const busyThread = await kernel.thread.create(
        "thread_edge_busy_branch",
        schema.schemaId,
        "branch_edge_busy_branch"
      );
      const busyTurn = await kernel.turn.create(
        "turn_edge_busy_branch",
        busyThread.threadId,
        busyThread.branchId,
        null,
        busyThread.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_edge_busy_branch_active",
        busyTurn.turnId,
        busyThread.branchId,
        schema.schemaId,
        busyThread.rootTurnNodeHash,
        [{ deterministic: false, id: "first", sideEffects: false }]
      );
      const busyBranchCode = await captureSemanticErrorCode(async () => {
        await kernel.run.create(
          "run_edge_busy_branch_rejected",
          busyTurn.turnId,
          busyThread.branchId,
          schema.schemaId,
          busyThread.rootTurnNodeHash,
          [{ deterministic: false, id: "next", sideEffects: false }]
        );
      });

      const orderedThread = await kernel.thread.create(
        "thread_edge_step_order",
        schema.schemaId,
        "branch_edge_step_order"
      );
      const orderedTurn = await kernel.turn.create(
        "turn_edge_step_order",
        orderedThread.threadId,
        orderedThread.branchId,
        null,
        orderedThread.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_edge_step_order",
        orderedTurn.turnId,
        orderedThread.branchId,
        schema.schemaId,
        orderedThread.rootTurnNodeHash,
        [
          { deterministic: false, id: "first", sideEffects: false },
          { deterministic: false, id: "second", sideEffects: false },
        ]
      );
      const outOfOrderStepCode = await captureSemanticErrorCode(async () => {
        await kernel.run.beginStep("run_edge_step_order", "second");
      });

      const missingEventThread = await kernel.thread.create(
        "thread_edge_missing_event",
        schema.schemaId,
        "branch_edge_missing_event"
      );
      const missingEventTurn = await kernel.turn.create(
        "turn_edge_missing_event",
        missingEventThread.threadId,
        missingEventThread.branchId,
        null,
        missingEventThread.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_edge_missing_event",
        missingEventTurn.turnId,
        missingEventThread.branchId,
        schema.schemaId,
        missingEventThread.rootTurnNodeHash,
        [{ deterministic: false, id: "event_step", sideEffects: false }]
      );
      const missingEventObjectCode = await captureSemanticErrorCode(
        async () => {
          await kernel.run.completeStep(
            "run_edge_missing_event",
            "event_step",
            "a".repeat(64)
          );
        }
      );

      const lateralThread = await kernel.thread.create(
        "thread_edge_lateral",
        schema.schemaId,
        "branch_edge_lateral_main"
      );
      const bootstrapTurn = await kernel.turn.create(
        "turn_edge_lateral_bootstrap",
        lateralThread.threadId,
        lateralThread.branchId,
        null,
        lateralThread.rootTurnNodeHash
      );
      await kernel.run.create(
        "run_edge_lateral_bootstrap",
        bootstrapTurn.turnId,
        lateralThread.branchId,
        schema.schemaId,
        lateralThread.rootTurnNodeHash,
        [{ deterministic: false, id: "bootstrap", sideEffects: false }]
      );
      const bootstrapCheckpoint = await kernel.run.completeStep(
        "run_edge_lateral_bootstrap",
        "bootstrap"
      );

      if (bootstrapCheckpoint.turnNodeHash === undefined) {
        throw new Error("expected bootstrap lateral checkpoint");
      }

      await kernel.run.complete("run_edge_lateral_bootstrap", "completed");
      const mainTurn = await kernel.turn.create(
        "turn_edge_lateral_main",
        lateralThread.threadId,
        lateralThread.branchId,
        bootstrapTurn.turnId,
        bootstrapCheckpoint.turnNodeHash
      );
      await kernel.run.create(
        "run_edge_lateral_main",
        mainTurn.turnId,
        lateralThread.branchId,
        schema.schemaId,
        bootstrapCheckpoint.turnNodeHash,
        [{ deterministic: false, id: "main", sideEffects: false }]
      );
      const mainEventHash = await kernel.store.put(
        new TextEncoder().encode("lateral-main")
      );
      const mainCheckpoint = await kernel.run.completeStep(
        "run_edge_lateral_main",
        "main",
        mainEventHash
      );

      if (mainCheckpoint.turnNodeHash === undefined) {
        throw new Error("expected main lateral checkpoint");
      }

      await kernel.run.complete("run_edge_lateral_main", "completed");
      const forkBranch = await kernel.branch.create(
        "branch_edge_lateral_fork",
        lateralThread.threadId,
        bootstrapCheckpoint.turnNodeHash
      );
      const forkTurn = await kernel.turn.create(
        "turn_edge_lateral_fork",
        lateralThread.threadId,
        forkBranch.branchId,
        bootstrapTurn.turnId,
        bootstrapCheckpoint.turnNodeHash
      );
      await kernel.run.create(
        "run_edge_lateral_fork",
        forkTurn.turnId,
        forkBranch.branchId,
        schema.schemaId,
        bootstrapCheckpoint.turnNodeHash,
        [{ deterministic: false, id: "fork", sideEffects: false }]
      );
      const forkEventHash = await kernel.store.put(
        new TextEncoder().encode("lateral-fork")
      );
      const forkCheckpoint = await kernel.run.completeStep(
        "run_edge_lateral_fork",
        "fork",
        forkEventHash
      );

      const forkTurnNodeHash = forkCheckpoint.turnNodeHash;

      if (forkTurnNodeHash === undefined) {
        throw new Error("expected fork lateral checkpoint");
      }

      await kernel.run.complete("run_edge_lateral_fork", "completed");
      const lateralHeadCode = await captureSemanticErrorCode(async () => {
        await kernel.branch.setHead(lateralThread.branchId, forkTurnNodeHash);
      });

      return createProjection({
        protocolEdgeValidation: {
          branch: { lateralHeadCode },
          run: {
            busyBranchCode,
            missingEventObjectCode,
            outOfOrderStepCode,
          },
          schema: { duplicatePathCode },
          tree: {
            missingRequiredPathCode,
            schemaMismatchCode,
          },
        },
      });
    });
  };

  return Object.freeze({
    deterministicHashing: async (input: unknown) =>
      await deterministicHashing(codec, input),
    readProtocolFixture,
    runBranchList,
    runCanonicalRejection: (fixture: Record<string, unknown>) =>
      runCanonicalRejection(codec, fixture),
    runCrossThreadLineage,
    runLogicalDiff,
    runModifyComposition,
    runProtocolEdgeValidation,
    runRecoveryState,
    runThreadList,
    schemaRoundtrip: (fixture: Record<string, unknown>) =>
      schemaRoundtrip(codec, fixture),
  });
};
