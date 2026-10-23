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

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { createMemoryBackend as CreateMemoryBackend } from "@tuvren/backend-memory";
import type {
  createPostgresBackend as CreatePostgresBackend,
  destroyPostgresBackend as DestroyPostgresBackend,
} from "@tuvren/backend-postgres";
import type { createSqliteBackend as CreateSqliteBackend } from "@tuvren/backend-sqlite";
import type {
  RuntimeBackend,
  StoredBranch,
  StoredThread,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createFaultInjectingBackend,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import type {
  FaultInjectingBackendFactory,
  FaultPoint,
} from "@tuvren/kernel-testkit";

import { createProjection } from "./host-scenario-support.js";
import type {
  KernelAdapterConfig,
  ManagedRuntimeBackend,
} from "./host-scenario-support.js";
import {
  conformanceBackend,
  createConformanceRuntimeKernel,
  readErrorCode,
  runRestartRecoveryPhase,
} from "./host-support.js";

interface CrashRecoveryBackendHarness {
  cleanup: () => void | Promise<void>;
  createBackend: () => ManagedRuntimeBackend | Promise<ManagedRuntimeBackend>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasCreateMemoryBackend = (
  value: unknown
): value is { createMemoryBackend: typeof CreateMemoryBackend } =>
  isRecord(value) && typeof value.createMemoryBackend === "function";

const hasCreateSqliteBackend = (
  value: unknown
): value is { createSqliteBackend: typeof CreateSqliteBackend } =>
  isRecord(value) && typeof value.createSqliteBackend === "function";

const hasPostgresBackendFactories = (
  value: unknown
): value is {
  createPostgresBackend: typeof CreatePostgresBackend;
  destroyPostgresBackend: typeof DestroyPostgresBackend;
} =>
  isRecord(value) &&
  typeof value.createPostgresBackend === "function" &&
  typeof value.destroyPostgresBackend === "function";

const runConcurrentWriterConflictOnBackends = async (
  primaryBackend: RuntimeBackend,
  secondaryBackend: RuntimeBackend
): Promise<Record<string, unknown>> => {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [],
    },
    2
  );
  const eventObjectA = await createStoredObjectRecord(new Uint8Array([1]), 3);
  const eventObjectB = await createStoredObjectRecord(new Uint8Array([2]), 4);
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 5,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const siblingNodeA = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 6,
    eventHash: eventObjectA.hash,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const siblingNodeB = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 7,
    eventHash: eventObjectB.hash,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 8,
    rootTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_concurrent_branch_head",
  };
  const branch: StoredBranch = {
    branchId: "branch_concurrent_branch_head",
    createdAtMs: 9,
    headTurnNodeHash: rootNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 9,
  };

  await primaryBackend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );
    await tx.objects.put(eventObjectA);
    await tx.objects.put(eventObjectB);
    await tx.turnNodes.put(rootNode);
    await tx.turnNodes.put(siblingNodeA);
    await tx.turnNodes.put(siblingNodeB);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
  });

  const [firstResult, secondResult] = await Promise.allSettled([
    primaryBackend.transact(async (tx) => {
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: siblingNodeA.hash,
        updatedAtMs: 10,
      });
    }),
    secondaryBackend.transact(async (tx) => {
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: siblingNodeB.hash,
        updatedAtMs: 11,
      });
    }),
  ]);

  let finalHead: string | null = null;

  await primaryBackend.transact(async (tx) => {
    const storedBranch = await tx.branches.get(branch.branchId);
    finalHead = storedBranch?.headTurnNodeHash ?? null;
  });

  const winningHead =
    firstResult.status === "fulfilled" ? siblingNodeA.hash : siblingNodeB.hash;
  const losingResult =
    firstResult.status === "rejected" ? firstResult : secondResult;
  const losingErrorCode =
    losingResult.status === "rejected"
      ? readErrorCode(losingResult.reason)
      : "missing_rejection";
  let retryAfterLossErrorCode: string | null = null;

  if (!losingErrorCode.endsWith("_branch_head_lateral_move")) {
    const losingBackend =
      firstResult.status === "rejected" ? primaryBackend : secondaryBackend;
    const losingHead =
      firstResult.status === "rejected" ? siblingNodeA.hash : siblingNodeB.hash;
    const followUpUpdatedAtMs = firstResult.status === "rejected" ? 12 : 13;

    try {
      await losingBackend.transact(async (tx) => {
        await tx.branches.set({
          ...branch,
          headTurnNodeHash: losingHead,
          updatedAtMs: followUpUpdatedAtMs,
        });
      });
    } catch (error: unknown) {
      retryAfterLossErrorCode = readErrorCode(error);
    }
  }

  return {
    finalHeadIsCommittedSibling:
      finalHead === siblingNodeA.hash || finalHead === siblingNodeB.hash,
    finalHeadMatchesWinner: finalHead === winningHead,
    losingErrorCode,
    retryAfterLossErrorCode,
    singleWriterRejected:
      [firstResult, secondResult].filter(
        (settledResult) => settledResult.status === "rejected"
      ).length === 1,
    typedLateralConflictObserved:
      losingErrorCode.endsWith("_branch_head_lateral_move") ||
      retryAfterLossErrorCode?.endsWith("_branch_head_lateral_move") === true,
  };
};

const conformanceFaultInjection = (
  config: Pick<KernelAdapterConfig, "mutant">
): FaultInjectingBackendFactory =>
  config.mutant?.wrapFaultInjection(createFaultInjectingBackend) ??
  createFaultInjectingBackend;

const runFaultPlanConcurrentWriterExercise = async (
  baseBackend: RuntimeBackend,
  faultInjection: FaultInjectingBackendFactory
): Promise<Record<string, unknown>> => {
  const schema = {
    ...createCanonicalKernelTestSchema(),
    schemaId: "schema_fault_plan_concurrent_writer",
  } satisfies TurnTreeSchema;
  const schemaRecord = createStoredSchemaRecord(schema, 21);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [],
    },
    22
  );
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 23,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const childNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 24,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 25,
    rootTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_fault_plan_concurrent_writer",
  };
  const branch: StoredBranch = {
    branchId: "branch_fault_plan_concurrent_writer",
    createdAtMs: 26,
    headTurnNodeHash: rootNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 26,
  };

  await baseBackend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );
    await tx.turnNodes.put(rootNode);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
  });

  const faultBackend: ManagedRuntimeBackend = faultInjection(baseBackend, {
    concurrentWriter: {
      branchId: branch.branchId,
    },
    match: {
      branchId: branch.branchId,
      operation: "checkpoint",
    },
    point: "before-commit",
    policy: "once",
  });

  let injectedErrorCode = "no_error";

  try {
    await faultBackend.transact(async (tx) => {
      await tx.turnNodes.put(childNode);
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: childNode.hash,
        updatedAtMs: 27,
      });
    });
  } catch (error: unknown) {
    injectedErrorCode = readErrorCode(error);
  }

  const inspection = await baseBackend.transact(async (tx) => {
    const currentBranch = await tx.branches.get(branch.branchId);
    const currentHead =
      currentBranch === null
        ? null
        : await tx.turnNodes.get(currentBranch.headTurnNodeHash);

    return {
      branch: currentBranch,
      head: currentHead,
    };
  });

  return {
    injectedErrorCode,
    writerAdvancedHead:
      inspection.branch !== null &&
      inspection.branch.headTurnNodeHash !== branch.headTurnNodeHash &&
      inspection.branch.headTurnNodeHash !== childNode.hash,
    writerProducedSiblingHead:
      inspection.head !== null &&
      inspection.head.previousTurnNodeHash === rootNode.hash,
  };
};

const closeManagedBackend = async (
  backend: ManagedRuntimeBackend,
  ignoreErrors = false
): Promise<void> => {
  if (typeof backend.close !== "function") {
    return;
  }

  try {
    await backend.close();
  } catch (error: unknown) {
    if (!ignoreErrors) {
      throw error;
    }
  }
};

const closeManagedBackends = async (
  backends: readonly ManagedRuntimeBackend[],
  index = 0
): Promise<void> => {
  const backend = backends[index];
  if (backend === undefined) {
    return;
  }

  await closeManagedBackend(backend, true);
  await closeManagedBackends(backends, index + 1);
};

const runCrashRecoveryFaultPoint = async (
  config: Pick<KernelAdapterConfig, "mutant">,
  harness: CrashRecoveryBackendHarness,
  point: FaultPoint,
  reopenDurably: boolean
): Promise<Record<string, unknown>> => {
  const baseBackend = await harness.createBackend();
  const kernel = createConformanceRuntimeKernel(config, {
    backend: baseBackend,
  });
  const schema = {
    ...createCanonicalKernelTestSchema(),
    schemaId: `schema_fault_${point.replaceAll("-", "_")}`,
  } satisfies TurnTreeSchema;
  const schemaId = await kernel.schema.register(schema);
  const thread = await kernel.thread.create(
    `thread_fault_${point.replaceAll("-", "_")}`,
    schemaId,
    `branch_fault_${point.replaceAll("-", "_")}`
  );
  const turn = await kernel.turn.create(
    `turn_fault_${point.replaceAll("-", "_")}`,
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const runId = `run_fault_${point.replaceAll("-", "_")}`;

  await kernel.run.create(
    runId,
    turn.turnId,
    thread.branchId,
    schemaId,
    thread.rootTurnNodeHash,
    [
      { deterministic: false, id: "model_call", sideEffects: false },
      { deterministic: false, id: "tool_execution", sideEffects: true },
    ]
  );

  await kernel.run.beginStep(runId, "model_call");
  const committed = await kernel.staging.stage(
    runId,
    new TextEncoder().encode(`committed output ${point}`),
    `message_committed_${point.replaceAll("-", "_")}`,
    "message",
    "completed"
  );
  const firstCheckpoint = await kernel.run.completeStep(runId, "model_call");

  if (firstCheckpoint.turnNodeHash === undefined) {
    throw new Error(`expected baseline checkpoint for ${point}`);
  }

  const faultBackend = conformanceFaultInjection(config)(baseBackend, {
    match: { operation: "checkpoint" },
    point,
    policy: "once",
  });
  const faultKernel = createConformanceRuntimeKernel(config, {
    backend: faultBackend,
  });

  await faultKernel.run.beginStep(runId, "tool_execution");
  const pending = await faultKernel.staging.stage(
    runId,
    new TextEncoder().encode(`pending output ${point}`),
    `message_pending_${point.replaceAll("-", "_")}`,
    "message",
    "completed"
  );

  let injectedErrorCode = "no_error";

  try {
    await faultKernel.run.completeStep(runId, "tool_execution");
  } catch (error: unknown) {
    injectedErrorCode = readErrorCode(error);
  }

  let inspectionBackend: ManagedRuntimeBackend = baseBackend;

  if (reopenDurably) {
    await closeManagedBackend(baseBackend);
    inspectionBackend = await harness.createBackend();
  }

  try {
    const inspectionKernel = createConformanceRuntimeKernel(config, {
      backend: inspectionBackend,
    });
    const branch = await inspectionKernel.branch.get(thread.branchId);

    if (branch === null) {
      throw new Error(`expected branch "${thread.branchId}" after ${point}`);
    }

    const headNode = await inspectionKernel.node.get(branch.headTurnNodeHash);

    if (headNode === null) {
      throw new Error(
        `expected branch head "${branch.headTurnNodeHash}" after ${point}`
      );
    }

    const manifest = await inspectionKernel.tree.manifest(
      headNode.turnTreeHash
    );
    const messages = Array.isArray(manifest.messages) ? manifest.messages : [];
    const recovery = await inspectionKernel.run.recover(runId);
    const walkBackHashes: string[] = [];

    for await (const turnNode of inspectionKernel.node.walkBack(
      branch.headTurnNodeHash
    )) {
      walkBackHashes.push(turnNode.hash);

      if (walkBackHashes.length === 3) {
        break;
      }
    }

    const committedFaultCheckpoint = point !== "before-commit";

    return {
      headMatchesExpectedCheckpoint: committedFaultCheckpoint
        ? branch.headTurnNodeHash !== firstCheckpoint.turnNodeHash
        : branch.headTurnNodeHash === firstCheckpoint.turnNodeHash,
      injectedErrorCode,
      lineageConsistent: committedFaultCheckpoint
        ? walkBackHashes[1] === firstCheckpoint.turnNodeHash &&
          walkBackHashes[2] === thread.rootTurnNodeHash
        : walkBackHashes[0] === firstCheckpoint.turnNodeHash &&
          walkBackHashes[1] === thread.rootTurnNodeHash,
      pendingMessageCommitted: messages.includes(pending.objectHash),
      recoveryStateConsistent: committedFaultCheckpoint
        ? recovery.lastCompletedStepId === "tool_execution" &&
          recovery.lastTurnNodeHash === branch.headTurnNodeHash &&
          recovery.uncommittedStagedResults.length === 0
        : recovery.lastCompletedStepId === "model_call" &&
          recovery.lastTurnNodeHash === firstCheckpoint.turnNodeHash &&
          recovery.uncommittedStagedResults.some(
            (stagedResult) => stagedResult.objectHash === pending.objectHash
          ),
      visibleCommittedMessageCount: messages.filter(
        (hash) => hash === committed.objectHash || hash === pending.objectHash
      ).length,
    };
  } finally {
    if (inspectionBackend !== baseBackend) {
      await closeManagedBackend(inspectionBackend);
    }
  }
};

const createCrashRecoveryHarness = async (
  config: Pick<KernelAdapterConfig, "backend" | "mutant">
): Promise<CrashRecoveryBackendHarness> => {
  const { backend } = config;
  if (backend === "memory") {
    const memoryBackendModule: unknown = await import(
      new URL("../../backends/memory/dist/index.js", import.meta.url).href
    );
    if (!hasCreateMemoryBackend(memoryBackendModule)) {
      throw new Error("memory backend module is missing its factory");
    }
    const { createMemoryBackend } = memoryBackendModule;

    return {
      cleanup: () => {
        // Memory harnesses have no external resources to release.
      },
      createBackend: () => conformanceBackend(config, createMemoryBackend()),
    };
  }

  if (backend === "sqlite") {
    const sqliteBackendModule: unknown = await import(
      new URL("../../backends/sqlite/dist/index.js", import.meta.url).href
    );
    if (!hasCreateSqliteBackend(sqliteBackendModule)) {
      throw new Error("sqlite backend module is missing its factory");
    }
    const { createSqliteBackend } = sqliteBackendModule;
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), `tuvren-crash-recovery-${process.pid}-`)
    );
    const databasePath = path.join(tempDirectory, "kernel.sqlite");
    const handles = new Set<ManagedRuntimeBackend>();

    return {
      cleanup: async () => {
        await closeManagedBackends([...handles]);
        await rm(tempDirectory, { force: true, recursive: true });
      },
      createBackend: () => {
        const handle = createSqliteBackend({
          databasePath,
        });
        handles.add(handle);
        return handle;
      },
    };
  }

  const postgresBackendModule: unknown = await import(
    new URL("../../backends/postgres/dist/index.js", import.meta.url).href
  );
  if (!hasPostgresBackendFactories(postgresBackendModule)) {
    throw new Error("postgres backend module is missing its factories");
  }
  const schemaName = `crash_${randomUUID().replaceAll("-", "_")}`;
  const options = {
    database: process.env.PGDATABASE ?? "tuvren_runtime",
    schemaName,
  };
  const handles = new Set<ManagedRuntimeBackend>();

  return {
    cleanup: async () => {
      await closeManagedBackends([...handles]);
      await postgresBackendModule.destroyPostgresBackend(options);
    },
    createBackend: () => {
      const handle = postgresBackendModule.createPostgresBackend(options);
      handles.add(handle);
      return handle;
    },
  };
};

const runPostgresRestartRecovery = async (): Promise<
  Record<string, unknown>
> => {
  const postgresBackendModule: unknown = await import(
    new URL("../../backends/postgres/dist/index.js", import.meta.url).href
  );
  if (!hasPostgresBackendFactories(postgresBackendModule)) {
    throw new Error("postgres backend module is missing its factories");
  }
  const { createPostgresBackend, destroyPostgresBackend } =
    postgresBackendModule;
  const restartSchema: TurnTreeSchema = {
    incorporationRules: [{ objectType: "message", targetPath: "messages" }],
    paths: [
      { collection: "ordered", path: "messages" },
      { collection: "single", path: "context.manifest" },
    ],
    schemaId: "schema_restart_recovery",
  };
  const schemaName = `restart_${randomUUID().replaceAll("-", "_")}`;
  const options = {
    database: process.env.PGDATABASE ?? "tuvren_runtime",
    schemaName,
  };
  const firstBackend = createPostgresBackend(options);
  let reopenedBackend: ReturnType<typeof createPostgresBackend> | undefined;

  try {
    const firstKernel = createRuntimeKernel({ backend: firstBackend });
    const schemaId = await firstKernel.schema.register(restartSchema);
    const thread = await firstKernel.thread.create(
      "thread_restart",
      schemaId,
      "branch_restart"
    );
    const turn = await firstKernel.turn.create(
      "turn_restart",
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await firstKernel.run.create(
      "run_restart",
      turn.turnId,
      thread.branchId,
      schemaId,
      thread.rootTurnNodeHash,
      [
        { deterministic: false, id: "model_call", sideEffects: false },
        { deterministic: false, id: "tool_execution", sideEffects: true },
      ]
    );
    await firstKernel.run.beginStep("run_restart", "model_call");
    const committed = await firstKernel.staging.stage(
      "run_restart",
      new TextEncoder().encode("committed assistant output"),
      "message_committed",
      "message",
      "completed"
    );
    const checkpoint = await firstKernel.run.completeStep(
      "run_restart",
      "model_call"
    );

    if (checkpoint.turnNodeHash === undefined) {
      throw new Error("expected checkpoint hash for postgres restart recovery");
    }

    await firstKernel.run.beginStep("run_restart", "tool_execution");
    const uncommitted = await firstKernel.staging.stage(
      "run_restart",
      new TextEncoder().encode("uncommitted tool output"),
      "message_uncommitted",
      "message",
      "completed"
    );

    // Close the first backend client before reopening the same disposable
    // schema so repeated conformance runs do not accumulate idle pools.
    await firstBackend.close();
    reopenedBackend = createPostgresBackend(options);
    const reopenedKernel = createRuntimeKernel({
      backend: reopenedBackend,
    });
    const branch = await reopenedKernel.branch.get(thread.branchId);

    if (branch === null) {
      throw new Error(`expected branch "${thread.branchId}" after reopen`);
    }

    const committedNode = await reopenedKernel.node.get(
      checkpoint.turnNodeHash
    );

    if (committedNode === null) {
      throw new Error(
        `expected committed turn node "${checkpoint.turnNodeHash}" after reopen`
      );
    }

    const manifest = await reopenedKernel.tree.manifest(
      committedNode.turnTreeHash
    );
    const committedMessages = Array.isArray(manifest.messages)
      ? manifest.messages
      : [];
    const recovery = await reopenedKernel.run.recover("run_restart");
    const walkBackHashes: string[] = [];

    for await (const turnNode of reopenedKernel.node.walkBack(
      branch.headTurnNodeHash
    )) {
      walkBackHashes.push(turnNode.hash);

      if (walkBackHashes.length === 2) {
        break;
      }
    }

    return createProjection({
      restartRecovery: {
        checkpointLineageSurvivesRestart:
          committedNode.previousTurnNodeHash === thread.rootTurnNodeHash &&
          walkBackHashes[0] === checkpoint.turnNodeHash &&
          walkBackHashes[1] === thread.rootTurnNodeHash,
        committedMessageCount: committedMessages.length,
        committedStateVisible:
          branch.headTurnNodeHash === checkpoint.turnNodeHash &&
          committedMessages.length === 1 &&
          committedMessages[0] === committed.objectHash,
        recoveredLastCompletedStepId: recovery.lastCompletedStepId,
        recoveredUncommittedCount: recovery.uncommittedStagedResults.length,
        recoveryHeadMatchesCommittedCheckpoint:
          recovery.lastTurnNodeHash === checkpoint.turnNodeHash,
        uncommittedNotPromoted:
          !committedMessages.includes(uncommitted.objectHash) &&
          recovery.uncommittedStagedResults.some(
            (stagedResult) => stagedResult.objectHash === uncommitted.objectHash
          ),
      },
    });
  } finally {
    await firstBackend.close();

    await (reopenedBackend === undefined
      ? destroyPostgresBackend(options)
      : reopenedBackend.destroy({ dropSchema: true }));
  }
};

export const createRestartRecoveryScenarios = (config: KernelAdapterConfig) => {
  const runRestartRecovery = async (): Promise<Record<string, unknown>> => {
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), "tuvren-kernel-restart-")
    );
    const databasePath = path.join(tempDirectory, "kernel.sqlite");
    const metadataPath = path.join(tempDirectory, "restart-metadata.json");

    try {
      if (config.backend === "postgres") {
        return await runPostgresRestartRecovery();
      }

      await runRestartRecoveryPhase("write", databasePath, metadataPath);
      const reopened = await runRestartRecoveryPhase(
        "read",
        databasePath,
        metadataPath
      );

      return createProjection({
        restartRecovery: reopened,
      });
    } finally {
      await rm(tempDirectory, { force: true, recursive: true });
    }
  };

  const runDurableCrashRecovery = async (): Promise<
    Record<string, unknown>
  > => {
    const harness = await createCrashRecoveryHarness(config);

    try {
      const afterCommitBeforeAck = await runCrashRecoveryFaultPoint(
        config,
        harness,
        "after-commit-before-ack",
        true
      );
      return createProjection({
        crashRecovery: {
          afterCommitBeforeAck,
          beforeCommit: await runCrashRecoveryFaultPoint(
            config,
            harness,
            "before-commit",
            true
          ),
          midCommit: afterCommitBeforeAck,
        },
      });
    } finally {
      await harness.cleanup();
    }
  };

  const runInProcessCrashRecovery = async (): Promise<
    Record<string, unknown>
  > => {
    const harness = await createCrashRecoveryHarness(config);

    try {
      const afterCommitBeforeAck = await runCrashRecoveryFaultPoint(
        config,
        harness,
        "after-commit-before-ack",
        false
      );
      return createProjection({
        crashRecovery: {
          afterCommitBeforeAck,
          beforeCommit: await runCrashRecoveryFaultPoint(
            config,
            harness,
            "before-commit",
            false
          ),
          midCommit: afterCommitBeforeAck,
        },
      });
    } finally {
      await harness.cleanup();
    }
  };

  const runConcurrentWriterConflict = async (): Promise<
    Record<string, unknown>
  > => {
    if (config.backend === "memory") {
      const memoryBackendModule: unknown = await import(
        new URL("../../backends/memory/dist/index.js", import.meta.url).href
      );
      if (!hasCreateMemoryBackend(memoryBackendModule)) {
        throw new Error("memory backend module is missing its factory");
      }
      const { createMemoryBackend } = memoryBackendModule;
      const seamBackend = conformanceBackend(config, createMemoryBackend());
      const raceBackend = conformanceBackend(config, createMemoryBackend());

      return createProjection({
        crashRecoveryConcurrency: await runConcurrentWriterConflictOnBackends(
          raceBackend,
          raceBackend
        ),
        faultPlanConcurrentWriter: await runFaultPlanConcurrentWriterExercise(
          seamBackend,
          conformanceFaultInjection(config)
        ),
      });
    }

    const harness = await createCrashRecoveryHarness(config);

    try {
      const [seamBackend, firstBackend, secondBackend] = await Promise.all([
        harness.createBackend(),
        harness.createBackend(),
        harness.createBackend(),
      ]);

      try {
        return createProjection({
          crashRecoveryConcurrency: await runConcurrentWriterConflictOnBackends(
            firstBackend,
            secondBackend
          ),
          faultPlanConcurrentWriter: await runFaultPlanConcurrentWriterExercise(
            seamBackend,
            conformanceFaultInjection(config)
          ),
        });
      } finally {
        await Promise.all([
          closeManagedBackend(seamBackend),
          closeManagedBackend(firstBackend),
          closeManagedBackend(secondBackend),
        ]);
      }
    } finally {
      await harness.cleanup();
    }
  };

  return Object.freeze({
    runConcurrentWriterConflict,
    runDurableCrashRecovery,
    runInProcessCrashRecovery,
    runRestartRecovery,
  });
};
