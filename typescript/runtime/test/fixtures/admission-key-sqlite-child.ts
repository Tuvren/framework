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

import { createSqliteBackend } from "@tuvren/backend-sqlite";
import type { InputSignal } from "@tuvren/core/execution";
import type { RuntimeRunner } from "@tuvren/core/runner";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

import { createRunnerRegistry, createTuvrenRuntime } from "../../src/index.ts";

const databasePath = process.argv[2];
if (databasePath === undefined || databasePath.length === 0) {
  throw new Error("SQLite child scenario requires a database path");
}

const backend = createSqliteBackend({ databasePath });

try {
  const runner = {
    async execute(context) {
      const repeatedSteeringCount = context.messages.filter(
        (message) =>
          message.role === "user" &&
          message.parts.some(
            (part) => part.type === "text" && part.text === "Repeated steering"
          )
      ).length;

      if (repeatedSteeringCount >= 2) {
        return {
          messages: [],
          resolution: { reason: "done", type: "end_turn" },
        };
      }

      if (repeatedSteeringCount === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      return {
        messages: [],
        resolution: { type: "continue_iteration" },
      };
    },
    id: "sqlite-admission-key",
  } satisfies RuntimeRunner;
  const runtime = createTuvrenRuntime({
    defaultRunnerId: runner.id,
    kernel: createRuntimeKernel({ backend }),
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: "primary" },
    signal: keyedSignal("Initial keyed input", "initial-key"),
    threadId: thread.threadId,
  });
  const events = handle.events()[Symbol.asyncIterator]();
  const draining = drain(events);

  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.steer(keyedSignal("Repeated steering", "steering-key-a"));
  handle.steer(keyedSignal("Repeated steering", "steering-key-b"));
  await draining;

  const { messages } = await runtime.readBranchMessages({
    branchId: thread.branchId,
  });
  process.stdout.write(
    JSON.stringify(
      messages.filter(
        (message) =>
          "role" in message &&
          message.role === "user" &&
          message.admissionKey !== undefined
      )
    )
  );
} finally {
  await backend.close();
}

function keyedSignal(text: string, admissionKey: string): InputSignal {
  return {
    admissionKey,
    parts: [{ text, type: "text" }],
  };
}

async function drain<T>(iterator: AsyncIterator<T>): Promise<void> {
  while (!(await iterator.next()).done) {
    // Pulling the stream drives execution.
  }
}
