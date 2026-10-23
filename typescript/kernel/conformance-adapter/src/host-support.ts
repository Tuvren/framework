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
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  createMemoryBackend as CreateMemoryBackend,
  createMemoryScopeStore as CreateMemoryScopeStore,
} from "@tuvren/backend-memory";
import type { createPostgresBackend as CreatePostgresBackend } from "@tuvren/backend-postgres";
import type { createSqliteBackend as CreateSqliteBackend } from "@tuvren/backend-sqlite";
import {
  assertRecoveryState,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
} from "@tuvren/kernel-protocol";
import type {
  RecoveryState,
  RuntimeBackend,
  StagedResult,
  TurnTreeChangeSet,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type {
  KernelMutantBackendContext,
  KernelMutantCodec,
} from "@tuvren/kernel-testkit";

import type { OperationOutcome } from "../../../../tools/conformance/adapter-protocol/index.js";
import type { KernelAdapterConfig } from "./host-scenario-support.js";

const CANONICAL_SCHEMA_URL = new URL(
  "../../../../spec/conformance/kernel/fixtures/canonical-turn-tree-schema.json",
  import.meta.url
);

const SQLITE_RESTART_SCENARIO_URL = new URL(
  "sqlite-restart-recovery-scenario.mjs",
  import.meta.url
);

type ConformanceConfig = Pick<
  KernelAdapterConfig,
  "adapterId" | "backend" | "mutant"
>;

const REFERENCE_CODEC: KernelMutantCodec = {
  decodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
};

export const conformanceCodec = (
  config: Pick<KernelAdapterConfig, "mutant">
): KernelMutantCodec =>
  config.mutant?.wrapCodec(REFERENCE_CODEC) ?? REFERENCE_CODEC;

export const conformanceBackend = (
  config: Pick<KernelAdapterConfig, "mutant">,
  backend: RuntimeBackend,
  context?: KernelMutantBackendContext
): RuntimeBackend => config.mutant?.wrapBackend(backend, context) ?? backend;

export const createConformanceRuntimeKernel = (
  config: Pick<KernelAdapterConfig, "mutant">,
  options: Parameters<typeof createRuntimeKernel>[0]
): ReturnType<typeof createRuntimeKernel> => {
  const kernel = createRuntimeKernel(options);
  return config.mutant?.wrapKernel(kernel, options.backend) ?? kernel;
};

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
  cleanup: () => Promise<void>;
}

let canonicalSchemaPromise: Promise<TurnTreeSchema> | undefined;

/**
 * Optional deterministic clock injected into a configured backend so a probe can
 * order durable writes against an active execution lease without relying on
 * wall-clock millisecond separation (which would make grace-window observations
 * flaky). When omitted, each backend uses its own default clock.
 */
export interface BackendClockOptions {
  now?: () => number;
}

// Two distinct, non-default Scopes bound to one shared substrate so the
// cross-scope isolation probe (KRT-BE007) can prove a co-tenant scope observes
// none of the constructing scope's content. The host supplies the Scope at
// construction (ADR-0048); the kernel syscall surface never sees it.
const CONFORMANCE_SCOPE_A = "tuvren.scope.conformance-a";
const CONFORMANCE_SCOPE_B = "tuvren.scope.conformance-b";

export interface ScopedBackendPair {
  backendA: RuntimeBackend;
  backendB: RuntimeBackend;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasCreatePostgresBackend = (
  value: unknown
): value is { createPostgresBackend: typeof CreatePostgresBackend } =>
  isRecord(value) && typeof value.createPostgresBackend === "function";

const hasCreateSqliteBackend = (
  value: unknown
): value is { createSqliteBackend: typeof CreateSqliteBackend } =>
  isRecord(value) && typeof value.createSqliteBackend === "function";

const hasMemoryBackendFactories = (
  value: unknown
): value is {
  createMemoryBackend: typeof CreateMemoryBackend;
  createMemoryScopeStore: typeof CreateMemoryScopeStore;
} =>
  isRecord(value) &&
  typeof value.createMemoryBackend === "function" &&
  typeof value.createMemoryScopeStore === "function";

export const loadCanonicalSchema = async (): Promise<TurnTreeSchema> => {
  canonicalSchemaPromise ??= (async () => {
    const contents = await readFile(CANONICAL_SCHEMA_URL, "utf-8");
    const value: unknown = JSON.parse(contents);

    assertTurnTreeSchema(value, "canonical kernel conformance schema");
    return value;
  })();

  return await canonicalSchemaPromise;
};

export const stageFixtureResult = async (
  kernel: ReturnType<typeof createRuntimeKernel>,
  runId: string,
  stagedResult: StagedResult,
  index: number
): Promise<void> => {
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
};

export const readErrorCode = (error: unknown): string => {
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
};

export const result = (value: Record<string, unknown>): OperationOutcome => ({
  kind: "result",
  value,
});

export const hexToBytes = (value: string): Uint8Array => {
  if (value.length % 2 !== 0) {
    throw new Error("fixture hex must have even length");
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
};

export const readRecord = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
};

const readArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }

  return value;
};

export const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  return value;
};

export const readFixture = (input: unknown): Record<string, unknown> => {
  const object = readRecord(input, "adapter input");
  return readRecord(object.fixture, "adapter input fixture");
};

/**
 * Like {@link readFixture}, but returns `undefined` instead of throwing when
 * the dispatch input carries no `fixture` field at all. Operations that must
 * stay backward-compatible with an input-less legacy check (e.g.
 * `kernel.protocol.modify-composition`'s original fixed-verdict scenario) use
 * this to detect fixture-driven invocations without breaking the fixture-less
 * ones.
 */
export const readFixtureOptional = (
  input: unknown
): Record<string, unknown> | undefined => {
  const object = readRecord(input, "adapter input");
  return object.fixture === undefined
    ? undefined
    : readRecord(object.fixture, "adapter input fixture");
};

export const readLogicalFixture = (
  fixture: Record<string, unknown>,
  schema: TurnTreeSchema
): LogicalFixture => {
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
  const { recoveryState } = fixture;
  assertRecoveryState(recoveryState, "recoveryState");
  const { turnTreeChangeSet } = fixture;
  assertTurnTreeChangeSet(turnTreeChangeSet, schema, "turnTreeChangeSet");

  return {
    branchHeadListEntry: [branchId, branchHead],
    recoveryState,
    turnTreeChangeSet,
  };
};

export const createConfiguredBackend = async (
  config: ConformanceConfig,
  options?: BackendClockOptions
): Promise<ConfiguredBackendHandle> => {
  const clock = options?.now === undefined ? {} : { now: options.now };

  if (config.backend === "postgres") {
    const postgresBackendModuleUrl = new URL(
      "../../backends/postgres/dist/index.js",
      import.meta.url
    );
    const postgresBackendModule: unknown = await import(
      postgresBackendModuleUrl.href
    );
    if (!hasCreatePostgresBackend(postgresBackendModule)) {
      throw new Error("postgres backend module is missing its factory");
    }
    const { createPostgresBackend } = postgresBackendModule;
    const schemaName = `${config.adapterId.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "_")}`;
    const backend = createPostgresBackend({
      database: process.env.PGDATABASE ?? "tuvren_runtime",
      schemaName,
      ...clock,
    });

    return {
      backend,
      cleanup: async () => {
        await backend.destroy({ dropSchema: true });
      },
    };
  }

  if (config.backend === "sqlite") {
    const sqliteBackendModuleUrl = new URL(
      "../../backends/sqlite/dist/index.js",
      import.meta.url
    );
    const sqliteBackendModule: unknown = await import(
      sqliteBackendModuleUrl.href
    );
    if (!hasCreateSqliteBackend(sqliteBackendModule)) {
      throw new Error("sqlite backend module is missing its factory");
    }
    const { createSqliteBackend } = sqliteBackendModule;
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), `${config.adapterId}-${process.pid}-`)
    );
    const databasePath = path.join(tempDirectory, `${randomUUID()}.sqlite`);
    return {
      backend: createSqliteBackend({ databasePath, ...clock }),
      cleanup: async () => {
        await rm(tempDirectory, { force: true, recursive: true });
      },
    };
  }

  const memoryBackendModuleUrl = new URL(
    "../../backends/memory/dist/index.js",
    import.meta.url
  );
  const memoryBackendModule: unknown = await import(
    memoryBackendModuleUrl.href
  );
  if (!hasMemoryBackendFactories(memoryBackendModule)) {
    throw new Error("memory backend module is missing its factories");
  }
  const { createMemoryBackend } = memoryBackendModule;
  return {
    backend: conformanceBackend(config, createMemoryBackend({ ...clock })),
    cleanup: async () => {
      // Memory backends have no external resources to release.
    },
  };
};

const createConformanceKernel = async (
  schema: TurnTreeSchema,
  config: ConformanceConfig
): Promise<{
  cleanup: () => Promise<void>;
  kernel: ReturnType<typeof createRuntimeKernel>;
}> => {
  const configuredBackend = await createConfiguredBackend(config);
  const kernel = createConformanceRuntimeKernel(config, {
    backend: configuredBackend.backend,
  });
  await kernel.schema.register(schema);
  return {
    cleanup: configuredBackend.cleanup,
    kernel,
  };
};

const createScopedBackendPair = async (
  config: ConformanceConfig
): Promise<{ cleanup: () => Promise<void>; pair: ScopedBackendPair }> => {
  if (config.backend === "postgres") {
    const postgresBackendModuleUrl = new URL(
      "../../backends/postgres/dist/index.js",
      import.meta.url
    );
    const postgresBackendModule: unknown = await import(
      postgresBackendModuleUrl.href
    );
    if (!hasCreatePostgresBackend(postgresBackendModule)) {
      throw new Error("postgres backend module is missing its factory");
    }
    const { createPostgresBackend } = postgresBackendModule;
    const schemaName = `${config.adapterId.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "_")}`;
    const baseOptions = {
      database: process.env.PGDATABASE ?? "tuvren_runtime",
      schemaName,
    };
    const backendA = createPostgresBackend({
      ...baseOptions,
      scope: CONFORMANCE_SCOPE_A,
    });
    const backendB = createPostgresBackend({
      ...baseOptions,
      scope: CONFORMANCE_SCOPE_B,
    });

    return {
      cleanup: async () => {
        // Close the co-tenant pool first, then drop the shared schema through
        // the surviving backend's destroy hook.
        await backendB.destroy();
        await backendA.destroy({ dropSchema: true });
      },
      pair: { backendA, backendB },
    };
  }

  if (config.backend === "sqlite") {
    const sqliteBackendModuleUrl = new URL(
      "../../backends/sqlite/dist/index.js",
      import.meta.url
    );
    const sqliteBackendModule: unknown = await import(
      sqliteBackendModuleUrl.href
    );
    if (!hasCreateSqliteBackend(sqliteBackendModule)) {
      throw new Error("sqlite backend module is missing its factory");
    }
    const { createSqliteBackend } = sqliteBackendModule;
    const tempDirectory = await mkdtemp(
      path.join(tmpdir(), `${config.adapterId}-${process.pid}-scope-`)
    );
    const databasePath = path.join(tempDirectory, `${randomUUID()}.sqlite`);
    const backendA = createSqliteBackend({
      databasePath,
      scope: CONFORMANCE_SCOPE_A,
    });
    const backendB = createSqliteBackend({
      databasePath,
      scope: CONFORMANCE_SCOPE_B,
    });

    return {
      cleanup: async () => {
        await backendA.close?.();
        await backendB.close?.();
        await rm(tempDirectory, { force: true, recursive: true });
      },
      pair: { backendA, backendB },
    };
  }

  const memoryBackendModuleUrl = new URL(
    "../../backends/memory/dist/index.js",
    import.meta.url
  );
  const memoryBackendModule: unknown = await import(
    memoryBackendModuleUrl.href
  );
  if (!hasMemoryBackendFactories(memoryBackendModule)) {
    throw new Error("memory backend module is missing its factories");
  }
  const { createMemoryBackend, createMemoryScopeStore } = memoryBackendModule;
  const store = createMemoryScopeStore();

  return {
    cleanup: async () => {
      // Memory backends have no external resources to release.
    },
    pair: {
      backendA: conformanceBackend(
        config,
        createMemoryBackend({ scope: CONFORMANCE_SCOPE_A, store }),
        { substrate: store }
      ),
      backendB: conformanceBackend(
        config,
        createMemoryBackend({ scope: CONFORMANCE_SCOPE_B, store }),
        { substrate: store }
      ),
    },
  };
};

export const withConformanceKernel = async <T>(
  schema: TurnTreeSchema,
  config: ConformanceConfig,
  execute: (kernel: ReturnType<typeof createRuntimeKernel>) => Promise<T>
): Promise<T> => {
  const configuredKernel = await createConformanceKernel(schema, config);

  try {
    return await execute(configuredKernel.kernel);
  } finally {
    await configuredKernel.cleanup();
  }
};

export const withConfiguredBackend = async <T>(
  config: ConformanceConfig,
  execute: (backend: RuntimeBackend) => Promise<T>,
  options?: BackendClockOptions
): Promise<T> => {
  const configuredBackend = await createConfiguredBackend(config, options);

  try {
    return await execute(configuredBackend.backend);
  } finally {
    await configuredBackend.cleanup();
  }
};

export const withScopedBackendPair = async <T>(
  config: ConformanceConfig,
  execute: (pair: ScopedBackendPair) => Promise<T>
): Promise<T> => {
  const handle = await createScopedBackendPair(config);

  try {
    return await execute(handle.pair);
  } finally {
    await handle.cleanup();
  }
};

export const runRestartRecoveryPhase = async (
  phase: "read" | "write",
  databasePath: string,
  metadataPath: string
): Promise<Record<string, unknown>> => {
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
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  await once(child, "close");

  if (child.exitCode !== 0) {
    throw new Error(
      `restart recovery ${phase} phase failed: code=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${stderr || "<empty>"}`
    );
  }

  const value: unknown = JSON.parse(stdout);
  return readRecord(value, `restart recovery ${phase} output`);
};
