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

import type { MemoryBackendOptions } from "@tuvren/backend-memory";
import { createMemoryBackend } from "@tuvren/backend-memory";
import type { PostgresBackendOptions } from "@tuvren/backend-postgres";
import { createPostgresBackend } from "@tuvren/backend-postgres";
import type { SqliteBackendOptions } from "@tuvren/backend-sqlite";
import { createSqliteBackend } from "@tuvren/backend-sqlite";
import { TuvrenValidationError } from "@tuvren/core";
import type { RuntimeDriverFactory } from "@tuvren/core/driver";
import type {
  AgentConfig,
  ExecutionBounds,
  OrchestrationRuntime,
  TuvrenRuntime,
} from "@tuvren/core/execution";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { PayloadCodec } from "@tuvren/core/lifecycle";
import type { TuvrenProvider } from "@tuvren/core/provider";
import type { TuvrenTelemetrySink } from "@tuvren/core/telemetry";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { ReActDriverOptions } from "@tuvren/driver-react";
import { createReActDriver } from "@tuvren/driver-react";
import type { RuntimeBackend, RuntimeKernel } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type { McpToolSource } from "@tuvren/mcp-client";
import { createDriverRegistry } from "./driver-registry.js";
import { createOrchestrationRuntime } from "./orchestration-runtime.js";
import {
  createTuvrenRuntime,
  type RuntimeCoreOptions,
} from "./runtime-core.js";

// ── Public type exports ─────────────────────────────────────────────────────

export type { MemoryBackendOptions } from "@tuvren/backend-memory";
export type { PostgresBackendOptions } from "@tuvren/backend-postgres";
export type { SqliteBackendOptions } from "@tuvren/backend-sqlite";
export type { ReActDriverOptions } from "@tuvren/driver-react";

export type BackendKind = "memory" | "sqlite" | "postgres";
export type DriverKind = "react";

/**
 * Structural interface for an MCP tool source. Defined here so hosts can
 * reference the type without importing `@tuvren/mcp-client` directly.
 * When Epic AS lands, `@tuvren/mcp-client` exports an identical structural
 * interface and the re-export from `@tuvren/runtime` in KRT-AS009 makes
 * the two structurally compatible.
 */
export interface CreateTuvrenOptions {
  /**
   * Backend spec or pre-built `RuntimeBackend` instance. When an explicit
   * instance is passed, `createTuvren` takes ownership: `[Symbol.asyncDispose]`
   * will call `close()` on it. Do not share a backend across multiple
   * `TuvrenInstance` objects unless you manage its lifecycle externally and
   * pass a no-op wrapper.
   */
  backend:
    | BackendKind
    | RuntimeBackend
    | { kind: "memory"; options?: MemoryBackendOptions }
    | { kind: "sqlite"; options: SqliteBackendOptions }
    | { kind: "postgres"; options?: PostgresBackendOptions };
  /**
   * Framework-enforced per-turn execution bounds (ADR-043, KRT-BD006). Supply
   * at the top level or via `runtimeOptions.bounds`, but not both. Unset fields
   * take the §3.11 safe defaults; a driver cannot raise or disable a bound.
   */
  bounds?: ExecutionBounds;
  driver?:
    | DriverKind
    | RuntimeDriverFactory
    | { kind: "react"; options?: ReActDriverOptions };
  extensions?: TuvrenExtension[];
  /** Pre-built kernel — when supplied the factory skips kernel construction. */
  kernel?: RuntimeKernel;
  /**
   * Opt-in crypto-shredding codec (ADR-051, KRT-BF005). Supply at the top level
   * or via `runtimeOptions.payloadCodec`, but not both. Unset defaults to a
   * plaintext identity codec, leaving existing hosts unchanged. Use
   * `createAesGcmPayloadCodec({ keyring })` from `@tuvren/runtime` for the
   * batteries-included AES-256-GCM codec, or implement `PayloadCodec` over a
   * KMS/HSM.
   */
  payloadCodec?: PayloadCodec;
  provider?: TuvrenProvider;
  runtimeOptions?: Omit<
    RuntimeCoreOptions,
    "defaultDriverId" | "driverRegistry" | "kernel"
  >;
  telemetry?: TuvrenTelemetrySink;
  tools?: Array<McpToolSource | TuvrenToolDefinition>;
}

export interface TuvrenInstance {
  kernel: RuntimeKernel;
  orchestration: OrchestrationRuntime;
  provider?: TuvrenProvider;
  runtime: TuvrenRuntime;
  [Symbol.asyncDispose](): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTuvren(
  options: CreateTuvrenOptions
): Promise<TuvrenInstance> {
  if (
    options.telemetry !== undefined &&
    options.runtimeOptions?.telemetry !== undefined
  ) {
    throw new TuvrenValidationError(
      "createTuvren: telemetry must be supplied either at top level or runtimeOptions, not both",
      { code: "invalid_createtuvren_options" }
    );
  }

  if (
    options.bounds !== undefined &&
    options.runtimeOptions?.bounds !== undefined
  ) {
    throw new TuvrenValidationError(
      "createTuvren: bounds must be supplied either at top level or runtimeOptions, not both",
      { code: "invalid_createtuvren_options" }
    );
  }

  if (
    options.payloadCodec !== undefined &&
    options.runtimeOptions?.payloadCodec !== undefined
  ) {
    throw new TuvrenValidationError(
      "createTuvren: payloadCodec must be supplied either at top level or runtimeOptions, not both",
      { code: "invalid_createtuvren_options" }
    );
  }

  // When a pre-built kernel is supplied, skip backend construction entirely.
  // The kernel already owns its backend; constructing a second one would open
  // an idle connection pool / file handle that is immediately discarded.
  const { kernel, disposeBackend, purgeScope } =
    resolveKernelAndDispose(options);

  const driver = buildDriver(options.driver);
  const driverRegistry = createDriverRegistry([driver]);

  const mcpSources = collectMcpSources(options.tools);
  const globalTools = collectTools(options.tools);

  const defaultAgentConfig: AgentConfig = {
    name: "agent",
    ...(options.provider === undefined ? {} : { model: options.provider }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
    ...(globalTools.length > 0 ? { tools: globalTools } : {}),
  };

  const runtime = createTuvrenRuntime({
    ...options.runtimeOptions,
    bounds: options.bounds ?? options.runtimeOptions?.bounds,
    defaultDriverId: driver.id,
    driverRegistry,
    kernel,
    payloadCodec: options.payloadCodec ?? options.runtimeOptions?.payloadCodec,
    ...(purgeScope === undefined ? {} : { purgeScope }),
    telemetry: options.telemetry ?? options.runtimeOptions?.telemetry,
  });

  const orchestration = createOrchestrationRuntime({
    agents: { agent: defaultAgentConfig },
    framework: runtime,
  });

  const instance: TuvrenInstance = {
    kernel,
    orchestration,
    runtime,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    async [Symbol.asyncDispose](): Promise<void> {
      const errors: Error[] = [];

      for (const source of mcpSources) {
        try {
          await source.close();
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      try {
        await disposeBackend();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      if (errors.length > 0) {
        const message = errors.map((e) => e.message).join("; ");
        throw new Error(`createTuvren disposal encountered errors: ${message}`);
      }
    },
  };

  return Promise.resolve(instance);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function resolveKernelAndDispose(options: CreateTuvrenOptions): {
  kernel: RuntimeKernel;
  disposeBackend: () => Promise<void>;
  purgeScope?: () => Promise<void>;
} {
  if (options.kernel !== undefined) {
    // An externally-supplied kernel owns its substrate; `createTuvren` has no
    // backend handle to drive a partition drop, so `maintenance.purgeScope`
    // stays unavailable on the resulting runtime.
    return { kernel: options.kernel, disposeBackend: () => Promise.resolve() };
  }
  const { backend, disposeBackend } = buildBackend(options.backend);
  return {
    kernel: createRuntimeKernel({ backend }),
    disposeBackend,
    // Surface the substrate partition-drop (ADR-051, §4.17) only when the owned
    // backend implements it; otherwise the runtime maintenance surface reports
    // it as unsupported.
    ...(typeof backend.purgeScope === "function"
      ? {
          purgeScope: (): Promise<void> =>
            backend.purgeScope?.() ?? Promise.resolve(),
        }
      : {}),
  };
}

function buildBackend(spec: CreateTuvrenOptions["backend"]): {
  backend: RuntimeBackend;
  disposeBackend: () => Promise<void>;
} {
  if (isRuntimeBackend(spec)) {
    return { backend: spec, disposeBackend: tryCloseBackend(spec) };
  }

  if (typeof spec === "string") {
    return buildBackendFromKind(spec, undefined);
  }

  return buildBackendFromKind(spec.kind, spec.options);
}

function buildBackendFromKind(
  kind: BackendKind,
  options: unknown
): { backend: RuntimeBackend; disposeBackend: () => Promise<void> } {
  switch (kind) {
    case "memory": {
      const b = createMemoryBackend(
        options as Parameters<typeof createMemoryBackend>[0]
      );
      return { backend: b, disposeBackend: () => Promise.resolve() };
    }
    case "sqlite": {
      if (
        options === undefined ||
        options === null ||
        typeof options !== "object" ||
        !("databasePath" in options)
      ) {
        throw new TuvrenValidationError(
          'createTuvren: "sqlite" backend requires options.databasePath',
          { code: "invalid_createtuvren_options" }
        );
      }
      const b = createSqliteBackend(
        options as Parameters<typeof createSqliteBackend>[0]
      );
      return { backend: b, disposeBackend: () => b.close() };
    }
    case "postgres": {
      const b = createPostgresBackend(
        options as Parameters<typeof createPostgresBackend>[0]
      );
      return { backend: b, disposeBackend: tryCloseBackend(b) };
    }
    default: {
      const _exhaustive: never = kind;
      throw new TuvrenValidationError(
        `createTuvren: unknown backend kind "${_exhaustive as string}"`,
        { code: "invalid_createtuvren_options" }
      );
    }
  }
}

function buildDriver(spec: CreateTuvrenOptions["driver"]) {
  if (spec === undefined || spec === "react") {
    return createReActDriver();
  }

  if (isRuntimeDriverFactory(spec)) {
    return spec;
  }

  const kindSpec = spec as { kind: string; options?: ReActDriverOptions };
  if (kindSpec.kind === "react") {
    return createReActDriver(kindSpec.options);
  }

  throw new TuvrenValidationError(
    `createTuvren: unknown driver kind "${kindSpec.kind}"`,
    { code: "invalid_createtuvren_options" }
  );
}

function collectMcpSources(
  tools: CreateTuvrenOptions["tools"]
): McpToolSource[] {
  if (tools === undefined) {
    return [];
  }
  return tools.filter(isMcpToolSource);
}

function collectTools(
  tools: CreateTuvrenOptions["tools"]
): TuvrenToolDefinition[] {
  if (tools === undefined) {
    return [];
  }
  const result: TuvrenToolDefinition[] = [];
  for (const item of tools) {
    if (isMcpToolSource(item)) {
      result.push(...item.tools);
    } else {
      result.push(item);
    }
  }
  return result;
}

function isMcpToolSource(
  item: McpToolSource | TuvrenToolDefinition
): item is McpToolSource {
  const obj = item as unknown as Record<string, unknown>;
  return (
    typeof obj.serverName === "string" &&
    typeof obj.refresh === "function" &&
    typeof obj.close === "function"
  );
}

function isRuntimeBackend(value: unknown): value is RuntimeBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).transact === "function" &&
    typeof (value as Record<string, unknown>).capabilities === "function"
  );
}

function isRuntimeDriverFactory(value: unknown): value is RuntimeDriverFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).create === "function" &&
    typeof (value as Record<string, unknown>).id === "string"
  );
}

function tryCloseBackend(backend: unknown): () => Promise<void> {
  const b = backend as Record<string, unknown>;
  if (typeof b.close === "function") {
    return () => (b.close as () => Promise<void>)();
  }
  return () => Promise.resolve();
}
