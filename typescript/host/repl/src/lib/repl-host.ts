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
import { createGrpcRuntimeKernel } from "@tuvren/kernel-grpc-client";
import { createReActRunner, REACT_RUNNER_ID } from "@tuvren/runner-react";
import { createTuvren, TuvrenRuntimeError } from "@tuvren/sdk";
import type { ExecutionHandle, RuntimeBackend } from "@tuvren/sdk";
import {
  createRunnerRegistry,
  createRuntimeKernel,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/sdk/advanced";
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

const createBackend = (config: ReplConfig): RuntimeBackend => {
  // The host binds every durable backend to its Scope (ADR-0048/0049, KRT-BE008),
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
};

const createKernel = (config: ReplConfig) => {
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
    // only the `RuntimeKernel` implementation so turn semantics, runners, and
    // provider orchestration stay identical across local and remote kernels.
    return createGrpcRuntimeKernel({
      baseUrl: config.kernelGrpcBaseUrl,
    });
  }

  const backend = createBackend(config);
  return createRuntimeKernel({ backend });
};

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const output: T[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
};

const projectHandle = async (
  handle: ExecutionHandle
): Promise<ReplStreamProjection> => {
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
};

const createReplHostFromParts = (
  config: ReplConfig,
  runtime: ReplHost["runtime"],
  provider: ReplHost["provider"],
  dispose?: () => Promise<void>
): ReplHost => ({
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
});

export const createReplHost = (config: ReplConfig): ReplHost => {
  const kernel = createKernel(config);
  const provider = createReplProvider({
    aimockBaseUrl: config.aimockBaseUrl,
    googleApiKey: config.googleApiKey,
    mode: config.providerMode,
    modelId: config.modelId,
    scenario: config.scenario,
  });
  const runtime = createTuvrenRuntimeCore({
    defaultRunnerId: REACT_RUNNER_ID,
    runnerRegistry: createRunnerRegistry([
      createReActRunner({
        providerCallMode: "stream",
      }),
    ]),
    kernel,
    // Correlate operational telemetry to the host-bound Scope (ADR-0048,
    // KRT-BE008). The Scope never crosses the kernel transport seam; it only
    // tags telemetry and (via the transcript header) the recorded session.
    ...(config.scope === undefined ? {} : { scope: config.scope }),
  });

  return createReplHostFromParts(config, runtime, provider);
};

export const createReplHostUsingCreateTuvren = async (
  config: ReplConfig
): Promise<ReplHost> => {
  const provider = createReplProvider({
    aimockBaseUrl: config.aimockBaseUrl,
    googleApiKey: config.googleApiKey,
    mode: config.providerMode,
    modelId: config.modelId,
    scenario: config.scenario,
  });
  const instance = await createTuvren({
    backend: createBackend(config),
    ...(config.kernelMode === "rust-grpc"
      ? { kernel: createKernel(config) }
      : {}),
    runner: createReActRunner({
      providerCallMode: "stream",
    }),
    provider,
    // Bind operational telemetry to the host's Scope (ADR-0048, KRT-BE008); the
    // durable backend is bound to the same Scope via createBackend.
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
};

export const createThreadSummary = async (
  host: ReplHost
): Promise<ReplThreadSummary> => await host.createThread();
