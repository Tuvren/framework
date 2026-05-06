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
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRecoveryState,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  type RecoveryState,
  type RuntimeBackend,
  type StagedResult,
  type TurnTreeChangeSet,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type { OperationOutcome } from "../../../../../../tools/conformance/adapter-protocol/index.js";

const CANONICAL_SCHEMA_URL = new URL(
  "../../../../conformance/fixtures/canonical-turn-tree-schema.json",
  import.meta.url
);

const SQLITE_RESTART_SCENARIO_URL = new URL(
  "./sqlite-restart-recovery-scenario.mjs",
  import.meta.url
);

export interface AdapterInput {
  fixture?: unknown;
}

export interface LogicalFixture {
  branchHeadListEntry: [string, string];
  recoveryState: RecoveryState;
  turnTreeChangeSet: TurnTreeChangeSet;
}

interface ConfiguredBackendHandle {
  backend: RuntimeBackend;
  cleanup(): Promise<void>;
}

let canonicalSchemaPromise: Promise<TurnTreeSchema> | undefined;

export async function withConformanceKernel<T>(
  schema: TurnTreeSchema,
  config: { adapterId: string; backend: "memory" | "sqlite" },
  execute: (kernel: ReturnType<typeof createRuntimeKernel>) => Promise<T>
): Promise<T> {
  const configuredKernel = await createConformanceKernel(schema, config);

  try {
    return await execute(configuredKernel.kernel);
  } finally {
    await configuredKernel.cleanup();
  }
}

export async function withConfiguredBackend<T>(
  config: { adapterId: string; backend: "memory" | "sqlite" },
  execute: (backend: RuntimeBackend) => Promise<T>
): Promise<T> {
  const configuredBackend = await createConfiguredBackend(config);

  try {
    return await execute(configuredBackend.backend);
  } finally {
    await configuredBackend.cleanup();
  }
}

export async function runRestartRecoveryPhase(
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

export async function loadCanonicalSchema(): Promise<TurnTreeSchema> {
  canonicalSchemaPromise ??= readFile(CANONICAL_SCHEMA_URL, "utf8")
    .then((contents) => JSON.parse(contents) as unknown)
    .then((value) => {
      assertTurnTreeSchema(value, "canonical kernel conformance schema");
      return value;
    });

  return await canonicalSchemaPromise;
}

export async function stageFixtureResult(
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

export function normalizeLogicalErrorCode(code: string): string {
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

export function readErrorCode(error: unknown): string {
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

export function result(value: Record<string, unknown>): OperationOutcome {
  return {
    kind: "result",
    value,
  };
}

export function readFixture(input: unknown): Record<string, unknown> {
  const object = readRecord(input, "adapter input") as AdapterInput;
  return readRecord(object.fixture, "adapter input fixture");
}

export function readLogicalFixture(
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

export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error("fixture hex must have even length");
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
}

export function readRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
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

export function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

async function createConformanceKernel(
  schema: TurnTreeSchema,
  config: { adapterId: string; backend: "memory" | "sqlite" }
): Promise<{
  cleanup(): Promise<void>;
  kernel: ReturnType<typeof createRuntimeKernel>;
}> {
  const configuredBackend = await createConfiguredBackend(config);
  const kernel = createRuntimeKernel({
    backend: configuredBackend.backend,
  });
  await kernel.schema.register(schema);
  return {
    cleanup: configuredBackend.cleanup,
    kernel,
  };
}

async function createConfiguredBackend(config: {
  adapterId: string;
  backend: "memory" | "sqlite";
}): Promise<ConfiguredBackendHandle> {
  if (config.backend === "sqlite") {
    const sqliteBackendModuleUrl = new URL(
      "../../backend-sqlite/dist/index.js",
      import.meta.url
    );
    const { createSqliteBackend } = await import(sqliteBackendModuleUrl.href);
    const tempDirectory = await mkdtemp(
      join(tmpdir(), `${config.adapterId}-${process.pid}-`)
    );
    const databasePath = join(tempDirectory, `${randomUUID()}.sqlite`);
    return {
      backend: createSqliteBackend({ databasePath }),
      cleanup: async () => {
        await rm(tempDirectory, { force: true, recursive: true });
      },
    };
  }

  const memoryBackendModuleUrl = new URL(
    "../../backend-memory/dist/index.js",
    import.meta.url
  );
  const { createMemoryBackend } = await import(memoryBackendModuleUrl.href);
  return {
    backend: createMemoryBackend(),
    cleanup: async () => {
      // Memory backends have no external resources to release.
    },
  };
}
