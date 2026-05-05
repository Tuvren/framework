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

import { readFile, writeFile } from "node:fs/promises";
import type { createSqliteBackend as CreateSqliteBackend } from "@tuvren/backend-sqlite";
import type { TurnTreeSchema } from "@tuvren/kernel-protocol";
import type { createRuntimeKernel as CreateRuntimeKernel } from "@tuvren/kernel-runtime";

interface RestartMetadata {
  branchId: string;
  committedMessageHash: string;
  committedTurnNodeHash: string;
  rootTurnNodeHash: string;
  runId: string;
  schemaId: string;
  threadId: string;
  turnId: string;
  uncommittedMessageHash: string;
}

const RESTART_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_restart_recovery",
} satisfies TurnTreeSchema;

await main();

async function main(): Promise<void> {
  const [, , phase, databasePath, metadataPath] = process.argv;

  if (
    (phase !== "write" && phase !== "read") ||
    databasePath === undefined ||
    metadataPath === undefined
  ) {
    throw new Error(
      "usage: bun sqlite-restart-recovery-scenario.ts <write|read> <databasePath> <metadataPath>"
    );
  }

  const output =
    phase === "write"
      ? await runWritePhase(databasePath, metadataPath)
      : await runReadPhase(databasePath, metadataPath);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function runWritePhase(
  databasePath: string,
  metadataPath: string
): Promise<Record<string, unknown>> {
  const { createRuntimeKernel, createSqliteBackend } = await loadNodeRuntime();
  const kernel = createRuntimeKernel({
    backend: createSqliteBackend({ databasePath }),
  });
  const schemaId = await kernel.schema.register(RESTART_SCHEMA);
  const thread = await kernel.thread.create(
    "thread_restart_recovery",
    schemaId,
    "branch_restart_recovery"
  );
  const turn = await kernel.turn.create(
    "turn_restart_recovery",
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  const runId = "run_restart_recovery";

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
    new TextEncoder().encode("committed assistant output"),
    "message_committed",
    "message",
    "completed"
  );
  const checkpoint = await kernel.run.completeStep(runId, "model_call");

  if (checkpoint.turnNodeHash === undefined) {
    throw new Error("expected checkpointed turn node hash");
  }

  await kernel.run.beginStep(runId, "tool_execution");
  const uncommitted = await kernel.staging.stage(
    runId,
    new TextEncoder().encode("uncommitted tool output"),
    "message_uncommitted",
    "message",
    "completed"
  );

  const metadata: RestartMetadata = {
    branchId: thread.branchId,
    committedMessageHash: committed.objectHash,
    committedTurnNodeHash: checkpoint.turnNodeHash,
    rootTurnNodeHash: thread.rootTurnNodeHash,
    runId,
    schemaId,
    threadId: thread.threadId,
    turnId: turn.turnId,
    uncommittedMessageHash: uncommitted.objectHash,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  return {
    branchId: metadata.branchId,
    committedTurnNodeHash: metadata.committedTurnNodeHash,
    runId: metadata.runId,
    wroteMetadata: true,
  };
}

async function runReadPhase(
  databasePath: string,
  metadataPath: string
): Promise<Record<string, unknown>> {
  const metadata = parseRestartMetadata(await readFile(metadataPath, "utf8"));
  const { createRuntimeKernel, createSqliteBackend } = await loadNodeRuntime();
  const kernel = createRuntimeKernel({
    backend: createSqliteBackend({ databasePath }),
  });
  const branch = await kernel.branch.get(metadata.branchId);

  if (branch === null) {
    throw new Error(`expected branch "${metadata.branchId}" after reopen`);
  }

  const committedNode = await kernel.node.get(metadata.committedTurnNodeHash);

  if (committedNode === null) {
    throw new Error(
      `expected committed turn node "${metadata.committedTurnNodeHash}" after reopen`
    );
  }

  const manifest = await kernel.tree.manifest(committedNode.turnTreeHash);
  const committedMessages = Array.isArray(manifest.messages)
    ? manifest.messages
    : [];
  const recovery = await kernel.run.recover(metadata.runId);
  const walkBackHashes: string[] = [];

  for await (const turnNode of kernel.node.walkBack(branch.headTurnNodeHash)) {
    walkBackHashes.push(turnNode.hash);

    if (walkBackHashes.length === 2) {
      break;
    }
  }

  return {
    checkpointLineageSurvivesRestart:
      committedNode.previousTurnNodeHash === metadata.rootTurnNodeHash &&
      walkBackHashes[0] === metadata.committedTurnNodeHash &&
      walkBackHashes[1] === metadata.rootTurnNodeHash,
    committedMessageCount: committedMessages.length,
    committedStateVisible:
      branch.headTurnNodeHash === metadata.committedTurnNodeHash &&
      committedMessages.length === 1 &&
      committedMessages[0] === metadata.committedMessageHash,
    recoveredLastCompletedStepId: recovery.lastCompletedStepId,
    recoveredUncommittedCount: recovery.uncommittedStagedResults.length,
    recoveryHeadMatchesCommittedCheckpoint:
      recovery.lastTurnNodeHash === metadata.committedTurnNodeHash,
    uncommittedNotPromoted:
      !committedMessages.includes(metadata.uncommittedMessageHash) &&
      recovery.uncommittedStagedResults.some(
        (stagedResult) =>
          stagedResult.objectHash === metadata.uncommittedMessageHash
      ),
  };
}

async function loadNodeRuntime(): Promise<{
  createRuntimeKernel: typeof CreateRuntimeKernel;
  createSqliteBackend: typeof CreateSqliteBackend;
}> {
  const runtimeKernelModuleUrl = new URL(
    "../../runtime-kernel/dist/index.js",
    import.meta.url
  );
  const backendSqliteModuleUrl = new URL(
    "../../backend-sqlite/dist/index.js",
    import.meta.url
  );
  const [runtimeKernelModule, backendSqliteModule] = await Promise.all([
    import(runtimeKernelModuleUrl.href),
    import(backendSqliteModuleUrl.href),
  ]);

  if (!hasCreateRuntimeKernel(runtimeKernelModule)) {
    throw new Error("runtime kernel module did not export createRuntimeKernel");
  }

  if (!hasCreateSqliteBackend(backendSqliteModule)) {
    throw new Error("sqlite backend module did not export createSqliteBackend");
  }

  return {
    createRuntimeKernel: runtimeKernelModule.createRuntimeKernel,
    createSqliteBackend: backendSqliteModule.createSqliteBackend,
  };
}

function parseRestartMetadata(jsonText: string): RestartMetadata {
  const value = JSON.parse(jsonText);
  return {
    branchId: readRequiredStringField(value, "branchId"),
    committedMessageHash: readRequiredStringField(
      value,
      "committedMessageHash"
    ),
    committedTurnNodeHash: readRequiredStringField(
      value,
      "committedTurnNodeHash"
    ),
    rootTurnNodeHash: readRequiredStringField(value, "rootTurnNodeHash"),
    runId: readRequiredStringField(value, "runId"),
    schemaId: readRequiredStringField(value, "schemaId"),
    threadId: readRequiredStringField(value, "threadId"),
    turnId: readRequiredStringField(value, "turnId"),
    uncommittedMessageHash: readRequiredStringField(
      value,
      "uncommittedMessageHash"
    ),
  };
}

function hasCreateRuntimeKernel(
  value: unknown
): value is { createRuntimeKernel: typeof CreateRuntimeKernel } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof Reflect.get(value, "createRuntimeKernel") === "function";
}

function hasCreateSqliteBackend(
  value: unknown
): value is { createSqliteBackend: typeof CreateSqliteBackend } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof Reflect.get(value, "createSqliteBackend") === "function";
}

function readRequiredStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "object" || value === null) {
    throw new Error("restart metadata must be a JSON object");
  }

  const fieldValue = Reflect.get(value, fieldName);

  if (typeof fieldValue !== "string") {
    throw new Error(`restart metadata field "${fieldName}" must be a string`);
  }

  return fieldValue;
}
