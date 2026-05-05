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

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  assertRecoveryState,
  assertStagedResult,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type RecoveryState,
  type StagedResult,
  type TurnTreeChangeSet,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";

declare const Bun: {
  file(path: string | URL): {
    json(): Promise<unknown>;
  };
};

const CANONICAL_SCHEMA_URL = new URL(
  "../../../../conformance/fixtures/canonical-turn-tree-schema.json",
  import.meta.url
);
const SQLITE_RESTART_SCENARIO_URL = new URL(
  "./sqlite-restart-recovery-scenario.ts",
  import.meta.url
);

interface AdapterInput {
  fixture?: unknown;
}

interface KernelAdapterConfig {
  adapterId: string;
  backend: "memory" | "sqlite";
  capabilities: string[];
}

interface LogicalFixture {
  branchHeadListEntry: [string, string];
  recoveryState: RecoveryState;
  turnTreeChangeSet: TurnTreeChangeSet;
}

const ADAPTER_CONFIG = readAdapterConfig(process.argv.slice(2));
let canonicalSchemaPromise: Promise<TurnTreeSchema> | undefined;
let sqliteRestartBuildPromise: Promise<void> | undefined;

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
      "kernel.logical",
      "kernel.run-liveness",
      "kernel.persistence.durable",
      "kernel.restart-recovery",
    ];
  }

  return [
    "kernel.protocol",
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
  const kernel = await createConformanceKernel(schema);
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
}

async function runLogicalDiff(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  const kernel = await createConformanceKernel(schema);
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
}

async function runBranchList(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  const kernel = await createConformanceKernel(schema);
  await kernel.thread.create(
    "thread_conformance",
    schema.schemaId,
    logical.branchHeadListEntry[0]
  );
  const branchEntries = await kernel.branch.list("thread_conformance");

  return { evidence: { branchEntries } };
}

async function runRecoveryState(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  const kernel = await createConformanceKernel(schema);
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
    throw new Error("logical recovery fixture must declare at least two steps");
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
}

async function runCrossThreadLineage(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const kernel = await createConformanceKernel(schema);
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
    throw new Error("expected checkpoint hash for cross-thread lineage check");
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
}

async function runLeaseRenewal(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const kernel = createRuntimeKernel({
    backend: createConfiguredBackend(),
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
}

async function runExpiredListing(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const backend = createConfiguredBackend();
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
}

async function runStalePreemption(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const backend = createConfiguredBackend();
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
}

async function runRestartRecovery(): Promise<Record<string, unknown>> {
  await ensureSqliteRestartRuntimeBuilt();
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

async function createConformanceKernel(schema: TurnTreeSchema) {
  // The Bun-hosted adapter keeps backend-agnostic semantics on the shared
  // in-memory kernel path. Durable SQLite behavior is proven separately through
  // the restart-recovery child process, because better-sqlite3 is not runnable
  // inside Bun in this environment.
  const kernel = createRuntimeKernel({
    backend: createConfiguredBackend(),
  });
  await kernel.schema.register(schema);
  return kernel;
}

function createConfiguredBackend() {
  return createMemoryBackend();
}

async function runRestartRecoveryPhase(
  phase: "read" | "write",
  databasePath: string,
  metadataPath: string
): Promise<Record<string, unknown>> {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(
      "node",
      [
        fileURLToPath(SQLITE_RESTART_SCENARIO_URL),
        phase,
        databasePath,
        metadataPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });

  if (result.code !== 0) {
    throw new Error(
      `restart recovery ${phase} phase failed: code=${String(result.code)} signal=${String(result.signal)} stderr=${result.stderr || "<empty>"}`
    );
  }

  const value = JSON.parse(result.stdout) as unknown;
  return readRecord(value, `restart recovery ${phase} output`);
}

async function ensureSqliteRestartRuntimeBuilt(): Promise<void> {
  sqliteRestartBuildPromise ??= (async () => {
    await runBuildTarget("backend-sqlite:build");
    await runBuildTarget("kernel-runtime:build");
  })();

  return await sqliteRestartBuildPromise;
}

async function runBuildTarget(target: string): Promise<void> {
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("bun", ["run", "nx", "run", target, "--skipNxCache"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });

  if (result.code !== 0) {
    throw new Error(
      `failed to build ${target} for sqlite restart recovery: code=${String(result.code)} signal=${String(result.signal)} stderr=${result.stderr || "<empty>"}`
    );
  }
}

async function loadCanonicalSchema(): Promise<TurnTreeSchema> {
  canonicalSchemaPromise ??= Bun.file(CANONICAL_SCHEMA_URL)
    .json()
    .then((value: unknown) => {
      assertTurnTreeSchema(value, "canonical kernel conformance schema");
      return value;
    });

  return await canonicalSchemaPromise;
}

async function stageFixtureResult(
  kernel: ReturnType<typeof createRuntimeKernel>,
  runId: string,
  stagedResult: StagedResult,
  index: number
): Promise<void> {
  await kernel.staging.stage(
    runId,
    new TextEncoder().encode(`fixture staged result ${index}`),
    stagedResult.taskId,
    stagedResult.objectType,
    stagedResult.status,
    stagedResult.status === "interrupted"
      ? stagedResult.interruptPayload
      : undefined
  );
}

function normalizeLogicalErrorCode(code: string): string {
  // The conformance plan stays binding-neutral, so the adapter translates
  // implementation-specific error codes into the stable shared evidence names.
  switch (code) {
    case "kernel_runtime_lineage_mismatch":
      return "turn_node_thread_mismatch";
    case "kernel_runtime_run_lease_owner_mismatch":
      return "run_lease_owner_mismatch";
    case "kernel_runtime_run_lease_token_mismatch":
      return "run_lease_token_mismatch";
    case "kernel_runtime_turn_head_lineage_mismatch":
      return "turn_head_lateral_move";
    default:
      return code;
  }
}

function readErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Reflect.get(error, "code");

    if (typeof code === "string") {
      return code;
    }
  }

  if (error instanceof Error) {
    return error.name;
  }

  return "unknown_error";
}

function result(value: Record<string, unknown>): OperationOutcome {
  return {
    kind: "result",
    value,
  };
}

function readFixture(input: unknown): Record<string, unknown> {
  const object = readRecord(input, "adapter input") as AdapterInput;
  return readRecord(object.fixture, "adapter input fixture");
}

function readLogicalFixture(
  fixture: Record<string, unknown>,
  schema: TurnTreeSchema
): LogicalFixture {
  const branchHeadListEntry = readArray(
    fixture.branchHeadListEntry,
    "branchHeadListEntry"
  );

  if (branchHeadListEntry.length !== 2) {
    throw new Error("branchHeadListEntry must contain exactly two items");
  }

  const branchId = readString(branchHeadListEntry[0], "branchHeadListEntry[0]");
  const branchHead = readString(
    branchHeadListEntry[1],
    "branchHeadListEntry[1]"
  );
  const recoveryState = fixture.recoveryState;
  assertRecoveryState(recoveryState, "recoveryState");
  const turnTreeChangeSet = fixture.turnTreeChangeSet;
  assertTurnTreeChangeSet(turnTreeChangeSet, schema, "turnTreeChangeSet");

  return {
    branchHeadListEntry: [branchId, branchHead],
    recoveryState,
    turnTreeChangeSet,
  };
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error("fixture hex must have even length");
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function readStagedResults(value: unknown, label: string): StagedResult[] {
  const results = readArray(value, label);
  const stagedResults: StagedResult[] = [];

  for (const [index, result] of results.entries()) {
    assertStagedResult(result, `${label}[${index}]`);
    stagedResults.push(result);
  }

  return stagedResults;
}

function readNumberArray(value: unknown, label: string): number[] {
  const values = readArray(value, label);

  if (!values.every((entry) => typeof entry === "number")) {
    throw new Error(`${label} must contain numbers`);
  }

  return values;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, label);
}
