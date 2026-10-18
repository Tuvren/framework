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

import type { TuvrenMessage } from "@tuvren/core/messages";
import type {
  RunnerExecutionResult,
  RuntimeRunner,
  RuntimeRunnerFactory,
} from "@tuvren/core/runner";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type { RuntimeKernelRunLiveness } from "@tuvren/kernel-protocol";

import { createRunnerRegistry as createBaseRunnerRegistry } from "../src/index.ts";
import {
  fromSynchronousVariadicAwaited,
  toOptionalRecord,
} from "./runtime-core-test-helpers.ts";

export interface TestRuntimeRunner {
  execute: (
    context: Parameters<RuntimeRunner["execute"]>[0]
  ) => RunnerExecutionResult | Promise<RunnerExecutionResult>;
  id: string;
  resume?: (
    context: Parameters<NonNullable<RuntimeRunner["resume"]>>[0]
  ) => RunnerExecutionResult | Promise<RunnerExecutionResult>;
}

type RuntimeRunLiveness = RuntimeKernelRunLiveness["runLiveness"];
export type TestRunLiveness = {
  [TKey in keyof RuntimeRunLiveness]: RuntimeRunLiveness[TKey] extends (
    ...parameters: infer TParameters
  ) => Promise<infer TResult>
    ? (...parameters: TParameters) => TResult | Promise<TResult>
    : RuntimeRunLiveness[TKey];
};

export const wrapTestRunLiveness = (
  runLiveness: TestRunLiveness
): RuntimeRunLiveness => ({
  createLeasedRun: fromSynchronousVariadicAwaited(runLiveness.createLeasedRun),
  listExpired: fromSynchronousVariadicAwaited(runLiveness.listExpired),
  preemptExpired: fromSynchronousVariadicAwaited(runLiveness.preemptExpired),
  renewLease: fromSynchronousVariadicAwaited(runLiveness.renewLease),
});

export const hasAssistantTextMessage = (
  messages: readonly unknown[],
  expectedText: string
): boolean =>
  messages.some((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "assistant" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  });

export const countUserTextMessages = (
  messages: readonly unknown[],
  expectedText: string
): number =>
  messages.filter((message) => {
    const record = toOptionalRecord(message);

    if (record?.role !== "user" || !Array.isArray(record.parts)) {
      return false;
    }

    return record.parts.some((part) => {
      const partRecord = toOptionalRecord(part);
      return partRecord?.type === "text" && partRecord.text === expectedText;
    });
  }).length;

export const toolResultMessage = (
  callId: string,
  value: number
): TuvrenMessage => ({
  parts: [
    {
      callId,
      name: "lookup",
      output: { value },
      type: "tool_result",
    },
  ],
  role: "tool",
});

export const requireAssistantMessage = (
  message: TuvrenMessage
): Extract<TuvrenMessage, { role: "assistant" }> => {
  if (message.role !== "assistant") {
    throw new Error("expected assistant message");
  }

  return message;
};

const isKrakenRunnerFactory = (
  entry: TestRuntimeRunner | RuntimeRunnerFactory
): entry is RuntimeRunnerFactory =>
  "create" in entry && typeof entry.create === "function";

const requestsToolExecution = (result: RunnerExecutionResult): boolean =>
  (result.messages ?? []).some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call")
  );

const normalizeRunnerResult = (
  result: RunnerExecutionResult
): RunnerExecutionResult => {
  if (
    result.toolExecutionMode !== undefined ||
    !requestsToolExecution(result)
  ) {
    return result;
  }

  return {
    ...result,
    toolExecutionMode: "parallel",
  };
};

const wrapRunner = (runner: TestRuntimeRunner): RuntimeRunner => {
  const { resume } = runner;

  return {
    async execute(context) {
      return normalizeRunnerResult(await runner.execute(context));
    },
    id: runner.id,
    ...(resume === undefined
      ? {}
      : {
          async resume(context) {
            return normalizeRunnerResult(await resume(context));
          },
        }),
  };
};

const wrapRunnerEntry = (
  entry: TestRuntimeRunner | RuntimeRunnerFactory
): RuntimeRunner | RuntimeRunnerFactory => {
  if (isKrakenRunnerFactory(entry)) {
    return {
      create() {
        return wrapRunner(entry.create());
      },
      id: entry.id,
    };
  }

  return wrapRunner(entry);
};

export const createRunnerRegistry = (
  runners: (TestRuntimeRunner | RuntimeRunnerFactory)[] = []
) => createBaseRunnerRegistry(runners.map(wrapRunnerEntry));

export const createTelemetryCapture = (): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
  spans: TelemetrySpan[];
} => {
  const events: TelemetryEvent[] = [];
  const spans: TelemetrySpan[] = [];

  return {
    events,
    sink: {
      event: (event) => {
        events.push(event);
      },
      span: (span) => {
        spans.push(span);
      },
    },
    spans,
  };
};
