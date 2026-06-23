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
import { type HashString as CoreHashString, isHashString } from "@tuvren/core";
import type {
  DriverExecutionContext,
  DriverExecutionResult,
  RuntimeDriver,
} from "@tuvren/core/driver";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ContextManifest, InputSignal } from "@tuvren/core/execution";
import type { ToolCallPart, TuvrenMessage } from "@tuvren/core/messages";
import type { TuvrenModelResponse } from "@tuvren/core/provider";
import type { ToolRegistry, TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  decodeDeterministicKernelRecord,
  type RunRecord,
  type RuntimeKernel,
  type RuntimeKernelRunLiveness,
  type TurnTreeManifest,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type { TuvrenProvider } from "@tuvren/provider-api";
import {
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import { decodeStoredRun } from "../../../../../kernel/implementations/typescript/runtime-kernel/src/lib/runtime-kernel-storage.ts";
import { createReActDriver } from "../../drivers/react/src/index.ts";

export interface AdapterProjection {
  events?: readonly unknown[];
  evidence?: Record<string, unknown>;
  result?: unknown;
  state?: Record<string, unknown>;
}

export interface ConformanceKernelHarness {
  kernel: RuntimeKernel & RuntimeKernelRunLiveness;
  readBranchManifest(branchId: string): Promise<TurnTreeManifest>;
  readBranchMessages(branchId: string): Promise<unknown[]>;
  readBranchRuns(branchId: string): Promise<RunRecord[]>;
  readBranchRuntimeStatus(branchId: string): Promise<unknown | null>;
  readRunningStagedMessages(branchId: string): Promise<unknown[]>;
  readTurnNodeManifest(turnNodeHash: CoreHashString): Promise<TurnTreeManifest>;
  readTurnNodeMessages(turnNodeHash: CoreHashString): Promise<unknown[]>;
}

export interface ConformanceRunLivenessKernelHarness {
  getPreemptCalls(): number;
  getRenewLeaseCalls(): number;
  kernel: RuntimeKernel & RuntimeKernelRunLiveness;
  leasedRuns: Map<string, RunRecord>;
}

export interface ScenarioToolCall {
  readonly callId: string;
  readonly input: unknown;
  readonly name: string;
  readonly output?: unknown;
  readonly requiresApproval?: boolean;
  readonly throwMessage?: string;
}

export const DRIVER_ID = "typescript-conformance-driver";
export const AGENT_NAME = "typescript-conformance-agent";

export function createConformanceKernelHarness(options?: {
  now?: () => number;
}): ConformanceKernelHarness {
  const backend = createMemoryBackend({ now: options?.now });
  const kernel = createRuntimeKernel({
    backend,
    now: options?.now,
  });

  return {
    kernel,
    async readBranchManifest(branchId) {
      const branch = await kernel.branch.get(branchId);

      if (branch === null) {
        throw new Error(`branch "${branchId}" not found`);
      }

      const turnNode = await kernel.node.get(branch.headTurnNodeHash);

      if (turnNode === null) {
        throw new Error(
          `branch "${branchId}" head turn node ${branch.headTurnNodeHash} not found`
        );
      }

      return await kernel.tree.manifest(turnNode.turnTreeHash);
    },
    async readBranchMessages(branchId) {
      const manifest = await this.readBranchManifest(branchId);
      return readMessagesFromManifest(kernel, manifest);
    },
    async readBranchRuntimeStatus(branchId) {
      const manifest = await this.readBranchManifest(branchId);
      const runtimeStatusHash = manifest["runtime.status"];

      if (!isHashString(runtimeStatusHash)) {
        return null;
      }

      const payload = await kernel.store.get(runtimeStatusHash);
      return payload === null ? null : decodeDeterministicKernelRecord(payload);
    },
    async readBranchRuns(branchId) {
      return await backend.transact((tx) =>
        tx.runs
          .listByBranch(branchId)
          .then((storedRuns) =>
            storedRuns.map((storedRun) => decodeStoredRun(storedRun))
          )
      );
    },
    async readRunningStagedMessages(branchId) {
      const runs = await this.readBranchRuns(branchId);
      const runningRun = runs.find((run) => run.status === "running");

      if (runningRun === undefined) {
        return [];
      }

      const stagedResults = await kernel.staging.current(runningRun.runId);
      const stagedMessages: unknown[] = [];

      for (const stagedResult of stagedResults) {
        if (stagedResult.objectType !== "message") {
          continue;
        }

        const payload = await kernel.store.get(stagedResult.objectHash);

        if (payload !== null) {
          stagedMessages.push(decodeDeterministicKernelRecord(payload));
        }
      }

      return stagedMessages;
    },
    async readTurnNodeManifest(turnNodeHash) {
      const turnNode = await kernel.node.get(turnNodeHash);

      if (turnNode === null) {
        throw new Error(`turn node ${turnNodeHash} not found`);
      }

      return await kernel.tree.manifest(turnNode.turnTreeHash);
    },
    async readTurnNodeMessages(turnNodeHash) {
      const manifest = await this.readTurnNodeManifest(turnNodeHash);
      return readMessagesFromManifest(kernel, manifest);
    },
  };
}

export function createConformanceRunLivenessKernelHarness(
  harness: ConformanceKernelHarness,
  options?: {
    onRenewLease?: (
      runId: string,
      executionOwnerId: string,
      fencingToken: string,
      nextLeaseExpiresAtMs: number
    ) => Promise<{ fencingToken: string; leaseExpiresAtMs: number }>;
  }
): ConformanceRunLivenessKernelHarness {
  const leasedRuns = new Map<string, RunRecord>();
  let preemptCalls = 0;
  let renewLeaseCalls = 0;
  const baseKernel = harness.kernel;

  return {
    getPreemptCalls() {
      return preemptCalls;
    },
    getRenewLeaseCalls() {
      return renewLeaseCalls;
    },
    kernel: {
      ...baseKernel,
      run: {
        ...baseKernel.run,
        async complete(runId, status, eventHash) {
          const completion = await baseKernel.run.complete(
            runId,
            status,
            eventHash
          );
          leasedRuns.delete(runId);
          return completion;
        },
      },
      runLiveness: {
        ...baseKernel.runLiveness,
        async createLeasedRun(input) {
          const run = await baseKernel.runLiveness.createLeasedRun(input);
          leasedRuns.set(run.runId, run);
          return run;
        },
        async preemptExpired(runId, preemptingOwnerId, nowMs, reason) {
          preemptCalls += 1;
          const recovery = await baseKernel.runLiveness.preemptExpired(
            runId,
            preemptingOwnerId,
            nowMs,
            reason
          );
          leasedRuns.delete(runId);
          return recovery;
        },
        async renewLease(
          runId,
          executionOwnerId,
          fencingToken,
          nextLeaseExpiresAtMs
        ) {
          renewLeaseCalls += 1;
          if (options?.onRenewLease !== undefined) {
            // A scenario can drive loss of execution authority (peer preemption
            // by another worker) by throwing here; the lease loop then aborts the
            // run handle, exercising the side-effect-once authority gates.
            return await options.onRenewLease(
              runId,
              executionOwnerId,
              fencingToken,
              nextLeaseExpiresAtMs
            );
          }
          const renewal = await baseKernel.runLiveness.renewLease(
            runId,
            executionOwnerId,
            fencingToken,
            nextLeaseExpiresAtMs
          );
          const leasedRun = leasedRuns.get(runId);

          if (leasedRun !== undefined) {
            leasedRuns.set(runId, {
              ...leasedRun,
              executionOwnerId,
              fencingToken: renewal.fencingToken,
              leaseExpiresAtMs: renewal.leaseExpiresAtMs,
            });
          }

          return renewal;
        },
      },
    },
    leasedRuns,
  };
}

export function createConformanceIdFactory(): () => string {
  let nextId = 1;

  // Compatibility evidence is checked in, so conformance-only runtime IDs stay
  // deterministic while the production runtime keeps its random default IDs.
  return () => `conformance-id-${nextId++}`;
}

export function createScenarioProvider(
  responses: readonly TuvrenModelResponse[],
  onGenerate: () => void
): TuvrenProvider {
  let responseIndex = 0;

  return {
    generate() {
      onGenerate();

      const response = responses[responseIndex] ?? responses.at(-1);

      if (response === undefined) {
        return Promise.reject(
          new Error("driver scenario must provide at least one response")
        );
      }

      responseIndex += 1;
      return Promise.resolve(structuredClone(response));
    },
    id: "provider",
    async *stream() {
      await Promise.resolve();
      yield* [];
    },
  };
}

export function createRuntimeWithReactDriver(): ReturnType<
  typeof createTuvrenRuntimeCore
> {
  const reactDriver = createReActDriver({
    providerCallMode: "generate",
  }).create();

  return createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: reactDriver.id,
    driverRegistry: createDriverRegistry([reactDriver]),
    kernel: createConformanceKernelHarness().kernel,
  });
}

export function createStaticDriver(
  execute: (
    context: DriverExecutionContext
  ) => DriverExecutionResult | Promise<DriverExecutionResult>
): RuntimeDriver {
  return {
    execute(context) {
      return Promise.resolve(execute(context));
    },
    id: DRIVER_ID,
  };
}

export function createDriverExecutionContext(input?: {
  config?: DriverExecutionContext["config"];
  emittedEvents?: TuvrenStreamEvent[];
  manifest?: ContextManifest;
  messages?: readonly TuvrenMessage[];
  signal?: AbortSignal;
  toolDefinitions?: TuvrenToolDefinition[];
}): DriverExecutionContext {
  const emittedEvents = input?.emittedEvents ?? [];
  const toolDefinitions = input?.toolDefinitions ?? [];

  return {
    branchId: "branch-1",
    config: input?.config ?? { name: AGENT_NAME },
    handoff: {
      createContextPlan({ reason, targetAgent }) {
        return {
          builder() {
            return [];
          },
          mode: "preserve_trace",
          reason,
          sourceContext: {
            handoffIntent: { targetAgent },
            helpers: {
              loadMessage() {
                return null;
              },
              storeMessage() {
                return "0".repeat(64);
              },
              storeMessages() {
                return [];
              },
            },
            manifest: createContextManifest(),
            messages: [],
            sourceAgent: { name: AGENT_NAME },
            targetAgent: { name: targetAgent },
          },
          targetAgent,
        };
      },
    },
    iterationCount: 1,
    manifest: input?.manifest ?? createContextManifest(),
    messages: input?.messages ?? [
      {
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    ],
    runtime: {
      emit(event) {
        emittedEvents.push(event);
      },
      now: createClock(),
    },
    schemaId: "tuvren.agent.v1",
    signal: input?.signal,
    threadId: "thread-1",
    toolRegistry: createToolRegistry(toolDefinitions),
    turnId: "turn-1",
  };
}

function createToolRegistry(
  tools: readonly TuvrenToolDefinition[]
): ToolRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    get(name: string) {
      return toolsByName.get(name);
    },
    has(name: string) {
      return toolsByName.has(name);
    },
    list() {
      return [...toolsByName.values()];
    },
    register(tool: TuvrenToolDefinition) {
      toolsByName.set(tool.name, tool);
    },
    toDefinitions() {
      return [...toolsByName.values()].map((tool) => ({
        description: tool.description,
        inputSchema: { type: "object" },
        name: tool.name,
      }));
    },
  };
}

function createContextManifest(): ContextManifest {
  return {
    byRole: {
      assistant: 0,
      system: 0,
      tool: 0,
      user: 1,
    },
    extensions: {},
    lastAssistantMessageIndex: -1,
    lastUserMessageIndex: 0,
    messageCount: 1,
    tokenEstimate: 0,
    toolCalls: {
      byName: {},
      total: 0,
    },
    toolResults: {
      byName: {},
      total: 0,
    },
    turnBoundaries: [0],
  };
}

export function assistantText(text: string): TuvrenMessage {
  return {
    parts: [{ text, type: "text" }],
    role: "assistant",
  };
}

export function assistantToolCalls(
  calls: readonly ScenarioToolCall[]
): TuvrenMessage {
  const firstCall = calls[0];

  if (firstCall === undefined) {
    throw new Error("tool call scenario must contain at least one call");
  }

  const remainingCalls = calls.slice(1);
  const parts: [ToolCallPart, ...ToolCallPart[]] = [
    toToolCallPart(firstCall),
    ...remainingCalls.map(toToolCallPart),
  ];

  return {
    parts,
    role: "assistant",
  };
}

function toToolCallPart(call: {
  callId: string;
  input: unknown;
  name: string;
}): ToolCallPart {
  return {
    callId: call.callId,
    input: call.input,
    name: call.name,
    type: "tool_call",
  };
}

export function textSignal(text: string): InputSignal {
  return {
    parts: [{ text, type: "text" }],
  };
}

export function createClock(): () => number {
  let now = 1;
  return () => now++;
}

export async function collectValues<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
}

async function readMessagesFromManifest(
  kernel: RuntimeKernel,
  manifest: TurnTreeManifest
): Promise<unknown[]> {
  const hashes = manifest.messages;

  if (!Array.isArray(hashes)) {
    return [];
  }

  const messages: unknown[] = [];

  for (const hash of hashes) {
    if (!isHashString(hash)) {
      continue;
    }

    const payload = await kernel.store.get(hash);

    if (payload !== null) {
      messages.push(decodeDeterministicKernelRecord(payload));
    }
  }

  return messages;
}
