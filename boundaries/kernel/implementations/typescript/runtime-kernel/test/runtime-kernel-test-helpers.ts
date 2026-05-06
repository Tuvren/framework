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
import type {
  RuntimeBackend,
  RuntimeKernel,
  RuntimeKernelRunLiveness,
  TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

export const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_runtime_test",
} satisfies TurnTreeSchema;

export interface RuntimeKernelFixture {
  backend: RuntimeBackend;
  branchId: string;
  kernel: RuntimeKernel & RuntimeKernelRunLiveness;
  rootTurnNodeHash: string;
  schemaId: string;
  threadId: string;
}

export async function createThreadFixture(
  input: { branchId?: string; now?: () => number; threadId?: string } = {}
): Promise<RuntimeKernelFixture> {
  const backend = createMemoryBackend();
  const kernel = createRuntimeKernel({
    backend,
    now: input.now,
  });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  const threadId = input.threadId ?? "thread_runtime_test";
  const branchId = input.branchId ?? "branch_runtime_test";
  const thread = await kernel.thread.create(threadId, schemaId, branchId);

  return {
    backend,
    branchId: thread.branchId,
    kernel,
    rootTurnNodeHash: thread.rootTurnNodeHash,
    schemaId,
    threadId: thread.threadId,
  };
}
