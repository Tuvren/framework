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

import path from "node:path";

import type {
  createMemoryBackend as CreateMemoryBackend,
  createMemoryScopeStore as CreateMemoryScopeStore,
} from "@tuvren/backend-memory";
import type { createPostgresBackend as CreatePostgresBackend } from "@tuvren/backend-postgres";
import type { createSqliteBackend as CreateSqliteBackend } from "@tuvren/backend-sqlite";
import {
  decodeDeterministicKernelRecord,
  hashOpaqueObjectBytes,
} from "@tuvren/kernel-protocol";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type {
  KernelMutantBackendContext,
  KernelMutantCodec,
} from "@tuvren/kernel-testkit";

import type { OperationOutcome } from "../../../../tools/conformance/adapter-protocol/index.js";
import type { KernelAdapterConfig } from "./host-scenario-support.js";

type ConformanceConfig = Pick<
  KernelAdapterConfig,
  "adapterId" | "backend" | "mutant" | "storageRef" | "scope"
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

interface ConfiguredBackendHandle {
  backend: RuntimeBackend;
  cleanup: () => Promise<void>;
}

/**
 * Optional deterministic clock injected into a configured backend so a probe can
 * order durable writes against an active execution lease without relying on
 * wall-clock millisecond separation (which would make grace-window observations
 * flaky). When omitted, each backend uses its own default clock.
 */
export interface BackendClockOptions {
  now?: () => number;
  store?: ReturnType<typeof CreateMemoryScopeStore>;
  substrate?: object;
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

export const readRecord = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
};

export const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  return value;
};

export const createMemorySubstrate = async (): Promise<
  ReturnType<typeof CreateMemoryScopeStore>
> => {
  const module: unknown = await import(
    new URL("../../backends/memory/dist/index.js", import.meta.url).href
  );
  if (!hasMemoryBackendFactories(module)) {
    throw new Error("memory backend module is missing its factories");
  }
  return module.createMemoryScopeStore();
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
    if (config.storageRef === undefined) {
      throw new Error("postgres storageRef is required");
    }
    const backend = createPostgresBackend({
      database: config.storageRef,
      schemaName: "tuvren_cert",
      ...(config.scope === undefined ? {} : { scope: config.scope }),
      ...clock,
    });

    return {
      backend: conformanceBackend(config, backend, {
        substrate: options?.substrate,
      }),
      cleanup: async () => {
        await backend.close();
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
    if (config.storageRef === undefined) {
      throw new Error("sqlite storageRef is required");
    }
    const databasePath = path.join(config.storageRef, "kernel.sqlite");
    const backend = createSqliteBackend({
      databasePath,
      ...(config.scope === undefined ? {} : { scope: config.scope }),
      ...clock,
    });
    return {
      backend: conformanceBackend(config, backend, {
        substrate: options?.substrate,
      }),
      cleanup: async () => {
        await backend.close();
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
    backend: conformanceBackend(
      config,
      createMemoryBackend({
        ...clock,
        scope: config.scope,
        store: options?.store,
      }),
      { substrate: options?.substrate }
    ),
    cleanup: async () => {
      // Memory backends have no external resources to release.
    },
  };
};
