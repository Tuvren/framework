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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertStagedResult,
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type StagedResult,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";
import {
  hexToBytes,
  loadCanonicalSchema,
  normalizeLogicalErrorCode,
  readErrorCode,
  readFixture,
  readLogicalFixture,
  readRecord,
  readString,
  result,
  runRestartRecoveryPhase,
  stageFixtureResult,
  withConfiguredBackend,
  withConformanceKernel,
} from "./host-support.js";

interface KernelAdapterConfig {
  adapterId: string;
  backend: "memory" | "sqlite";
  capabilities: string[];
}

const ADAPTER_CONFIG = readAdapterConfig(process.argv.slice(2));

class TypeScriptKernelAdapter {
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    return Promise.resolve({
      adapterId: ADAPTER_CONFIG.adapterId,
      capabilities: ADAPTER_CONFIG.capabilities,
      packetId,
      planVersion,
    });
  }

  async dispatch(
    operation: string,
    input: unknown,
    _controls: AdapterControls
  ): Promise<OperationOutcome> {
    try {
      switch (operation) {
        case "kernel.protocol.deterministic-hashing":
          return result(await deterministicHashing(readFixture(input)));
        case "kernel.protocol.schema-roundtrip":
          return result(schemaRoundtrip(readFixture(input)));
        case "kernel.protocol.modify-composition":
          return result(await runModifyComposition());
        case "kernel.protocol.edge-validation":
          return result(await runProtocolEdgeValidation());
        case "kernel.logical.diff-paths":
          return result(await runLogicalDiff(readFixture(input)));
        case "kernel.logical.branch-list":
          return result(await runBranchList(readFixture(input)));
        case "kernel.logical.recovery-state":
          return result(await runRecoveryState(readFixture(input)));
        case "kernel.lineage.cross-thread-rejection":
          return result(await runCrossThreadLineage());
        case "kernel.run-liveness.lease-renewal":
          return result(await runLeaseRenewal());
        case "kernel.run-liveness.expired-listing":
          return result(await runExpiredListing());
        case "kernel.run-liveness.stale-preemption":
          return result(await runStalePreemption());
        case "kernel.restart-recovery.close-reopen-checkpoint":
          return result(await runRestartRecovery());
        default:
          return {
            error: {
              code: "adapter_operation_not_implemented",
              message: `${ADAPTER_CONFIG.adapterId} does not implement ${operation}`,
            },
            kind: "error",
          };
      }
    } catch (error: unknown) {
      return {
        error: createAdapterErrorEnvelope(error),
        kind: "error",
      };
    }
  }
}

await serveStdioAdapter(new TypeScriptKernelAdapter());

function readAdapterConfig(args: readonly string[]): KernelAdapterConfig {
  const capabilities: string[] = [];
  let adapterId = "typescript-kernel-memory";
  let backend: KernelAdapterConfig["backend"] = "memory";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--adapter-id") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--adapter-id requires a value");
      }
      adapterId = value;
      index += 1;
      continue;
    }

    if (arg === "--backend") {
      const value = args[index + 1];
      if (value !== "memory" && value !== "sqlite") {
        throw new Error("--backend must be memory or sqlite");
      }
      backend = value;
      index += 1;
      continue;
    }

    if (arg === "--capability") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--capability requires a value");
      }
      capabilities.push(value);
      index += 1;
    }
  }

  return {
    adapterId,
    backend,
    capabilities:
      capabilities.length > 0 ? capabilities : defaultCapabilities(backend),
  };
}

function defaultCapabilities(
  backend: KernelAdapterConfig["backend"]
): string[] {
  if (backend === "sqlite") {
    return [
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.logical",
      "kernel.run-liveness",
      "kernel.persistence.durable",
      "kernel.restart-recovery",
    ];
  }

  return [
    "kernel.protocol",
    "kernel.edge-validation",
    "kernel.logical",
    "kernel.run-liveness",
    "kernel.persistence.process-local",
  ];
}

async function deterministicHashing(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rawOpaqueBytes = readNumberArray(
    fixture.rawOpaqueBytes,
    "rawOpaqueBytes"
  );
  const schemaRecord = decodeDeterministicKernelRecord(
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

  return {
    evidence: {
      hashes: {
        rawOpaqueBytes: await hashOpaqueObjectBytes(
          Uint8Array.from(rawOpaqueBytes)
        ),
        turnNodeIdentity: turnNodeHash,
        turnTreeSchema: await hashKernelRecord(schemaRecord),
      },
    },
  };
}

function schemaRoundtrip(
  fixture: Record<string, unknown>
): Record<string, unknown> {
  return {
    evidence: {
      roundtrip: {
        turnNodeIdentityRecord: decodeDeterministicKernelRecord(
          hexToBytes(
            readString(
              fixture.turnNodeIdentityRecordCborHex,
              "turnNodeIdentityRecordCborHex"
            )
          )
        ),
        turnTreeSchemaRecord: decodeDeterministicKernelRecord(
          hexToBytes(
            readString(
              fixture.turnTreeSchemaRecordCborHex,
              "turnTreeSchemaRecordCborHex"
            )
          )
        ),
      },
    },
  };
}

async function runModifyComposition(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
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

    return {
      evidence: {
        verdict: {
          kind: verdict.kind,
          transform: verdict.transform,
        },
      },
    };
  });
}

async function runLogicalDiff(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
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
    const diffPaths = (
      await kernel.tree.diff(created.rootTurnTreeHash, changedTree)
    ).toSorted();

    return { evidence: { diffPaths } };
  });
}

async function runBranchList(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    await kernel.thread.create(
      "thread_conformance",
      schema.schemaId,
      logical.branchHeadListEntry[0]
    );
    const branchEntries = await kernel.branch.list("thread_conformance");

    return { evidence: { branchEntries } };
  });
}

async function runRecoveryState(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
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

    for (const [
      index,
      stagedResult,
    ] of logical.recoveryState.consumedStagedResults.entries()) {
      await stageFixtureResult(kernel, "run_recovery", stagedResult, index);
    }

    await kernel.run.completeStep("run_recovery", secondStep.id);

    for (const [
      index,
      stagedResult,
    ] of logical.recoveryState.uncommittedStagedResults.entries()) {
      await stageFixtureResult(kernel, "run_recovery", stagedResult, index);
    }

    const recovery = await kernel.run.recover("run_recovery");

    return {
      evidence: {
        recovery: {
          consumedStagedResults: recovery.consumedStagedResults.length,
          lastCompletedStepId: recovery.lastCompletedStepId,
          uncommittedStagedResults: recovery.uncommittedStagedResults.length,
        },
      },
    };
  });
}

async function runCrossThreadLineage(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
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
      return {
        evidence: {
          diagnostics: ["thread A node unexpectedly seeded thread B branch"],
          errorCode: "unexpected_success",
        },
      };
    } catch (error: unknown) {
      return {
        evidence: {
          errorCode: normalizeLogicalErrorCode(readErrorCode(error)),
        },
      };
    }
  });
}

async function runProtocolEdgeValidation(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConformanceKernel(schema, ADAPTER_CONFIG, async (kernel) => {
    const firstPath = schema.paths[0];

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

    const missingRequiredPathCode = await captureSemanticErrorCode(async () => {
      await kernel.tree.create(schema.schemaId, { messages: [] });
    });

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
    const missingEventObjectCode = await captureSemanticErrorCode(async () => {
      await kernel.run.completeStep(
        "run_edge_missing_event",
        "event_step",
        "a".repeat(64)
      );
    });

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

    return {
      evidence: {
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
      },
    };
  });
}

async function captureSemanticErrorCode(
  execute: () => Promise<unknown>
): Promise<string> {
  try {
    await execute();
    return "unexpected_success";
  } catch (error: unknown) {
    return normalizeLogicalErrorCode(readErrorCode(error));
  }
}

async function runLeaseRenewal(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConfiguredBackend(ADAPTER_CONFIG, async (backend) => {
    const kernel = createRuntimeKernel({
      backend,
      now: () => 10,
    });
    await kernel.schema.register(schema);
    const thread = await kernel.thread.create(
      "thread_liveness_renewal",
      schema.schemaId,
      "branch_liveness_renewal"
    );
    const turn = await kernel.turn.create(
      "turn_liveness_renewal",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    const leasedRun = await kernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "owner-primary",
      leaseExpiresAtMs: 20,
      runId: "run_liveness_renewal",
      schemaId: schema.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: turn.turnId,
    });
    const staleToken = leasedRun.fencingToken ?? "";
    const renewed = await kernel.runLiveness.renewLease(
      leasedRun.runId,
      "owner-primary",
      staleToken,
      40
    );

    let ownerMismatchCode = "unexpected_success";
    try {
      await kernel.runLiveness.renewLease(
        leasedRun.runId,
        "owner-secondary",
        renewed.fencingToken,
        50
      );
    } catch (error: unknown) {
      ownerMismatchCode = normalizeLogicalErrorCode(readErrorCode(error));
    }

    let staleTokenCode = "unexpected_success";
    try {
      await kernel.runLiveness.renewLease(
        leasedRun.runId,
        "owner-primary",
        staleToken,
        50
      );
    } catch (error: unknown) {
      staleTokenCode = normalizeLogicalErrorCode(readErrorCode(error));
    }

    return {
      evidence: {
        renewal: {
          ownerMismatchCode,
          renewedLeaseExpiresAtMs: renewed.leaseExpiresAtMs,
          staleTokenCode,
        },
      },
    };
  });
}

async function runExpiredListing(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConfiguredBackend(ADAPTER_CONFIG, async (backend) => {
    const kernel = createRuntimeKernel({ backend });
    await kernel.schema.register(schema);
    const expiredThread = await kernel.thread.create(
      "thread_liveness_listing_expired",
      schema.schemaId,
      "branch_liveness_listing_expired"
    );
    const freshThread = await kernel.thread.create(
      "thread_liveness_listing_fresh",
      schema.schemaId,
      "branch_liveness_listing_fresh"
    );
    const pausedThread = await kernel.thread.create(
      "thread_liveness_listing_paused",
      schema.schemaId,
      "branch_liveness_listing_paused"
    );
    const expiredTurn = await kernel.turn.create(
      "turn_liveness_listing_expired",
      expiredThread.threadId,
      expiredThread.branchId,
      null,
      expiredThread.rootTurnNodeHash
    );
    const freshTurn = await kernel.turn.create(
      "turn_liveness_listing_fresh",
      freshThread.threadId,
      freshThread.branchId,
      null,
      freshThread.rootTurnNodeHash
    );
    const pausedTurn = await kernel.turn.create(
      "turn_liveness_listing_paused",
      pausedThread.threadId,
      pausedThread.branchId,
      null,
      pausedThread.rootTurnNodeHash
    );
    await kernel.runLiveness.createLeasedRun({
      branchId: expiredThread.branchId,
      executionOwnerId: "owner-primary",
      leaseExpiresAtMs: 5,
      runId: "run_expired",
      schemaId: schema.schemaId,
      startTurnNodeHash: expiredThread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: expiredTurn.turnId,
    });
    const freshRun = await kernel.runLiveness.createLeasedRun({
      branchId: freshThread.branchId,
      executionOwnerId: "owner-primary",
      leaseExpiresAtMs: 50,
      runId: "run_fresh",
      schemaId: schema.schemaId,
      startTurnNodeHash: freshThread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: freshTurn.turnId,
    });
    const pausedRun = await kernel.runLiveness.createLeasedRun({
      branchId: pausedThread.branchId,
      executionOwnerId: "owner-primary",
      // This lease is already stale before the pause so the evidence proves that
      // paused status, not remaining lease time, keeps it out of expired listings.
      leaseExpiresAtMs: 5,
      runId: "run_paused",
      schemaId: schema.schemaId,
      startTurnNodeHash: pausedThread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: pausedTurn.turnId,
    });
    await kernel.run.complete(freshRun.runId, "failed");
    await kernel.run.complete(pausedRun.runId, "paused");
    const expiredRuns = await kernel.runLiveness.listExpired(10);
    const pausedStoredRun = await backend.transact(async (tx) => {
      return await tx.runs.get(pausedRun.runId);
    });

    if (pausedStoredRun === null) {
      throw new Error("expected paused stored run");
    }

    return {
      evidence: {
        listing: {
          expiredRunIds: expiredRuns.map((run) => run.runId),
          pausedRunListed: expiredRuns.some(
            (run) => run.runId === pausedRun.runId
          ),
          pausedRunStatus: pausedStoredRun.status,
        },
      },
    };
  });
}

async function runStalePreemption(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  return await withConfiguredBackend(ADAPTER_CONFIG, async (backend) => {
    const storageKernel = createRuntimeKernel({ backend });
    await storageKernel.schema.register(schema);
    const thread = await storageKernel.thread.create(
      "thread_liveness_preemption",
      schema.schemaId,
      "branch_liveness_preemption"
    );
    const turn = await storageKernel.turn.create(
      "turn_liveness_preemption",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    const leasedRun = await storageKernel.runLiveness.createLeasedRun({
      branchId: thread.branchId,
      executionOwnerId: "owner-primary",
      leaseExpiresAtMs: 5,
      runId: "run_liveness_preemption",
      schemaId: schema.schemaId,
      startTurnNodeHash: thread.rootTurnNodeHash,
      steps: [{ deterministic: false, id: "iterate", sideEffects: true }],
      turnId: turn.turnId,
    });
    await storageKernel.run.beginStep(leasedRun.runId, "iterate");
    await storageKernel.staging.stage(
      leasedRun.runId,
      new TextEncoder().encode("assistant"),
      "assistant_message",
      "message",
      "completed"
    );
    const recovery = await storageKernel.runLiveness.preemptExpired(
      leasedRun.runId,
      "owner-secondary",
      10,
      "stale_running_recovery"
    );

    const storedRun = await backend.transact(async (tx) => {
      return await tx.runs.get(leasedRun.runId);
    });

    if (storedRun === null) {
      throw new Error("expected preempted stored run");
    }
    const updatedBranch = await storageKernel.branch.get(thread.branchId);

    if (updatedBranch === null) {
      throw new Error("expected preempted branch");
    }

    return {
      evidence: {
        preemption: {
          branchHeadTurnNodeHash: updatedBranch.headTurnNodeHash,
          leaseCleared:
            storedRun.executionOwnerId === undefined &&
            storedRun.fencingToken === undefined &&
            storedRun.leaseExpiresAtMs === undefined,
          preemptionReason: storedRun.preemptionReason ?? null,
          recoveryHeadMatchesBranchHead:
            recovery.lastTurnNodeHash === updatedBranch.headTurnNodeHash,
          recoveryLastTurnNodeHash: recovery.lastTurnNodeHash,
          runStatus: storedRun.status,
          uncommittedStagedResults: recovery.uncommittedStagedResults.length,
        },
      },
    };
  });
}

async function runRestartRecovery(): Promise<Record<string, unknown>> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "tuvren-kernel-restart-"));
  const databasePath = join(tempDirectory, "kernel.sqlite");
  const metadataPath = join(tempDirectory, "restart-metadata.json");

  try {
    await runRestartRecoveryPhase("write", databasePath, metadataPath);
    const reopened = await runRestartRecoveryPhase(
      "read",
      databasePath,
      metadataPath
    );

    return {
      evidence: {
        restartRecovery: reopened,
      },
    };
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

function readStagedResults(value: unknown, label: string): StagedResult[] {
  const results = Array.isArray(value)
    ? value
    : (() => {
        throw new Error(`${label} must be an array`);
      })();
  const stagedResults: StagedResult[] = [];

  for (const [index, result] of results.entries()) {
    assertStagedResult(result, `${label}[${index}]`);
    stagedResults.push(result);
  }

  return stagedResults;
}

function readNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  const values = value;

  if (!values.every((entry) => typeof entry === "number")) {
    throw new Error(`${label} must contain numbers`);
  }

  return values;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}
