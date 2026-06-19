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

import { createMemoryBackend } from "@tuvren/backend-memory";
import { createPostgresBackend } from "@tuvren/backend-postgres";
import { createSqliteBackend } from "@tuvren/backend-sqlite";
import { createReActDriver, REACT_DRIVER_ID } from "@tuvren/driver-react";
import {
  createDriverRegistry,
  createGrpcRuntimeKernel,
  createRuntimeKernel,
  createTuvren,
  createTuvrenRuntime as createTuvrenRuntimeCore,
  type ExecutionHandle,
  type RuntimeBackend,
  TuvrenRuntimeError,
} from "@tuvren/runtime";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import { INVALID_REPL_CONFIG_CODE } from "./repl-config.js";
import { createReplProvider } from "./repl-provider.js";
import type {
  ReplConfig,
  ReplHost,
  ReplStreamProjection,
  ReplThreadSummary,
} from "./repl-types.js";

export function createReplHost(config: ReplConfig): ReplHost {
  const kernel = createKernel(config);
  const provider = createReplProvider({
    aimockBaseUrl: config.aimockBaseUrl,
    googleApiKey: config.googleApiKey,
    modelId: config.modelId,
    mode: config.providerMode,
    scenario: config.scenario,
  });
  const runtime = createTuvrenRuntimeCore({
    defaultDriverId: REACT_DRIVER_ID,
    driverRegistry: createDriverRegistry([
      createReActDriver({
        providerCallMode: "stream",
      }),
    ]),
    kernel,
    // Correlate operational telemetry to the host-bound Scope (ADR-048,
    // KRT-BE008). The Scope never crosses the kernel transport seam; it only
    // tags telemetry and (via the transcript header) the recorded session.
    ...(config.scope === undefined ? {} : { scope: config.scope }),
  });

  return createReplHostFromParts(config, runtime, provider);
}

export async function createReplHostUsingCreateTuvren(
  config: ReplConfig
): Promise<ReplHost> {
  const provider = createReplProvider({
    aimockBaseUrl: config.aimockBaseUrl,
    googleApiKey: config.googleApiKey,
    modelId: config.modelId,
    mode: config.providerMode,
    scenario: config.scenario,
  });
  const instance = await createTuvren({
    backend: createTuvrenBackendConfig(config),
    ...(config.kernelMode === "rust-grpc"
      ? { kernel: createKernel(config) }
      : {}),
    driver: {
      kind: "react",
      options: {
        providerCallMode: "stream",
      },
    },
    provider,
    // Bind operational telemetry to the host's Scope (ADR-048, KRT-BE008); the
    // durable backend is bound to the same Scope via createTuvrenBackendConfig.
    ...(config.scope === undefined
      ? {}
      : { runtimeOptions: { scope: config.scope } }),
  });

  return createReplHostFromParts(
    config,
    instance.runtime,
    provider,
    async () => {
      await instance[Symbol.asyncDispose]();
    }
  );
}

function createReplHostFromParts(
  config: ReplConfig,
  runtime: ReplHost["runtime"],
  provider: ReplHost["provider"],
  dispose?: () => Promise<void>
): ReplHost {
  return {
    approve(handle, response) {
      return handle.resolveApproval(response);
    },
    async branchFromHead(input) {
      return await runtime.createBranch({
        branchId: input.branchId,
        fromTurnNodeHash: input.turnNodeHash,
        threadId: input.threadId,
      });
    },
    cancel(handle) {
      handle.cancel();
    },
    config,
    ...(dispose === undefined ? {} : { dispose }),
    async createThread() {
      const thread = await runtime.createThread({});
      return {
        branchId: thread.branchId,
        rootTurnNodeHash: thread.rootTurnNodeHash,
        rootTurnTreeHash: thread.rootTurnTreeHash,
        threadId: thread.threadId,
      };
    },
    executeTurn(input) {
      const requestedConfig = input.config;

      return runtime.executeTurn({
        branchId: input.branchId,
        config: {
          ...requestedConfig,
          model: requestedConfig?.model ?? provider,
          name: requestedConfig?.name ?? "primary",
          systemPrompt: requestedConfig?.systemPrompt ?? config.systemPrompt,
        },
        signal: input.signal,
        threadId: input.threadId,
      });
    },
    async project(handle) {
      return await projectHandle(handle);
    },
    async readBranchMessages(branchId) {
      const result = await runtime.readBranchMessages({ branchId });
      return result.messages;
    },
    provider,
    runtime,
    steer(handle, signal) {
      handle.steer(signal);
    },
  };
}

export async function createThreadSummary(
  host: ReplHost
): Promise<ReplThreadSummary> {
  return await host.createThread();
}

async function projectHandle(
  handle: ExecutionHandle
): Promise<ReplStreamProjection> {
  const [canonicalBranch, sseBranch, aguiBranch] = teeTuvrenStreamEvents(
    handle.events(),
    3
  );
  const [canonical, sse, agui] = await Promise.all([
    collect(canonicalBranch),
    collect(toSseFrames(sseBranch)),
    collect(toAgUiEvents(aguiBranch)),
  ]);

  return {
    agui,
    canonical,
    sse,
  };
}

function createKernel(config: ReplConfig) {
  if ((config.kernelMode ?? "typescript-local") === "rust-grpc") {
    if (config.kernelGrpcBaseUrl === undefined) {
      throw new TuvrenRuntimeError(
        "rust-grpc repl kernel requires a gRPC base URL",
        {
          code: INVALID_REPL_CONFIG_CODE,
        }
      );
    }

    // Epic V keeps the runtime switch below `TuvrenRuntime`: the host swaps
    // only the `RuntimeKernel` implementation so turn semantics, drivers, and
    // provider orchestration stay identical across local and remote kernels.
    return createGrpcRuntimeKernel({
      baseUrl: config.kernelGrpcBaseUrl,
    });
  }

  const backend = createBackend(config);
  return createRuntimeKernel({ backend });
}

function createBackend(config: ReplConfig): RuntimeBackend {
  // The host binds every durable backend to its Scope (ADR-048/049, KRT-BE008),
  // so a `--scope` REPL session isolates durable state by construction; an
  // unset Scope falls through to the single-tenant default each backend applies.
  const scopeOption = config.scope === undefined ? {} : { scope: config.scope };

  if (config.backend === "memory") {
    return createMemoryBackend(scopeOption);
  }

  if (config.backend === "postgres") {
    return createPostgresBackend({
      database: config.postgresDatabase,
      schemaName: config.postgresSchemaName,
      ...scopeOption,
    });
  }

  if (config.sqlitePath === undefined) {
    throw new TuvrenRuntimeError(
      "sqlite repl backend requires a database path",
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  return createSqliteBackend({
    databasePath: config.sqlitePath,
    ...scopeOption,
  });
}

function createTuvrenBackendConfig(
  config: ReplConfig
): Parameters<typeof createTuvren>[0]["backend"] {
  // Carry the host Scope into the backend spec so `createTuvren` constructs the
  // durable backend scope-bound (ADR-048/049, KRT-BE008); unset means default.
  const scopeOption = config.scope === undefined ? {} : { scope: config.scope };

  if (config.backend === "memory") {
    return { kind: "memory", options: scopeOption };
  }

  if (config.backend === "postgres") {
    return {
      kind: "postgres",
      options: {
        database: config.postgresDatabase,
        schemaName: config.postgresSchemaName,
        ...scopeOption,
      },
    };
  }

  if (config.sqlitePath === undefined) {
    throw new TuvrenRuntimeError(
      "sqlite repl backend requires a database path",
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  return {
    kind: "sqlite",
    options: {
      databasePath: config.sqlitePath,
      ...scopeOption,
    },
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
}
