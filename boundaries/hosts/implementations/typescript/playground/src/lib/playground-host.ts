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
import { createSqliteBackend } from "@tuvren/backend-sqlite";
import { TuvrenRuntimeError } from "@tuvren/core-types";
import { createReActDriver, REACT_DRIVER_ID } from "@tuvren/driver-react";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type { ExecutionHandle } from "@tuvren/runtime-api";
import {
  createDriverRegistry,
  createGrpcRuntimeKernel,
  createTuvrenRuntimeCore,
} from "@tuvren/runtime-core";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import {
  createPlaygroundKernelInspector,
  type PlaygroundKernelHarness,
} from "./playground-kernel.js";
import { createPlaygroundProvider } from "./playground-provider.js";
import type {
  PlaygroundConfig,
  PlaygroundHost,
  PlaygroundStreamProjection,
  PlaygroundThreadSummary,
} from "./playground-types.js";

export function createPlaygroundHost(config: PlaygroundConfig): PlaygroundHost {
  const harness = createKernelHarness(config);
  const provider = createPlaygroundProvider({
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
    kernel: harness.kernel,
  });

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
      return runtime.executeTurn({
        branchId: input.branchId,
        config: {
          ...input.config,
          model: input.config?.model ?? provider,
          name: input.config?.name ?? "primary",
        },
        signal: input.signal,
        threadId: input.threadId,
      });
    },
    async project(handle) {
      return await projectHandle(handle);
    },
    async readBranchMessages(branchId) {
      return await harness.readBranchMessages(branchId);
    },
    async readBranchStatus(branchId) {
      return await harness.readBranchStatus(branchId);
    },
    runtime,
    steer(handle, signal) {
      handle.steer(signal);
    },
  };
}

export async function createThreadSummary(
  host: PlaygroundHost
): Promise<PlaygroundThreadSummary> {
  return await host.createThread();
}

async function projectHandle(
  handle: ExecutionHandle
): Promise<PlaygroundStreamProjection> {
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

function createKernelHarness(
  config: PlaygroundConfig
): PlaygroundKernelHarness {
  if ((config.kernelMode ?? "typescript-local") === "rust-grpc") {
    if (config.kernelGrpcBaseUrl === undefined) {
      throw new TuvrenRuntimeError(
        "rust-grpc playground kernel requires a gRPC base URL",
        {
          code: "invalid_playground_config",
        }
      );
    }

    // Epic V keeps the runtime switch below `TuvrenRuntime`: the host swaps
    // only the `RuntimeKernel` implementation so turn semantics, drivers, and
    // provider orchestration stay identical across local and remote kernels.
    const kernel = createGrpcRuntimeKernel({
      baseUrl: config.kernelGrpcBaseUrl,
    });

    return {
      kernel,
      ...createPlaygroundKernelInspector(kernel),
    };
  }

  const backend = createBackend(config);
  const kernel = createRuntimeKernel({ backend });
  return { kernel, ...createPlaygroundKernelInspector(kernel) };
}

function createBackend(config: PlaygroundConfig): RuntimeBackend {
  if (config.backend === "memory") {
    return createMemoryBackend();
  }

  if (config.sqlitePath === undefined) {
    throw new TuvrenRuntimeError(
      "sqlite playground backend requires a database path",
      {
        code: "invalid_playground_config",
      }
    );
  }

  return createSqliteBackend({
    databasePath: config.sqlitePath,
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
}
