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

import { describe, expect, test } from "bun:test";
import { createMemoryBackend } from "@tuvren/backend-memory";
import type { RuntimeKernel, TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_runtime_test",
} satisfies TurnTreeSchema;

interface RuntimeKernelFixture {
  branchId: string;
  kernel: RuntimeKernel;
  rootTurnNodeHash: string;
  schemaId: string;
  threadId: string;
}

async function createThreadFixture(
  input: { branchId?: string; now?: () => number; threadId?: string } = {}
): Promise<RuntimeKernelFixture> {
  const kernel = createRuntimeKernel({
    backend: createMemoryBackend(),
    now: input.now,
  });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  const threadId = input.threadId ?? "thread_runtime_test";
  const branchId = input.branchId ?? "branch_runtime_test";
  const thread = await kernel.thread.create(threadId, schemaId, branchId);

  return {
    branchId: thread.branchId,
    kernel,
    rootTurnNodeHash: thread.rootTurnNodeHash,
    schemaId,
    threadId: thread.threadId,
  };
}

describe("createRuntimeKernel", () => {
  test("returns a truthy RuntimeKernel instance", () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    expect(kernel).toBeTruthy();
  });

  test("kernel has expected syscall namespaces", () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    expect(kernel.branch).toBeTruthy();
    expect(kernel.node).toBeTruthy();
    expect(kernel.run).toBeTruthy();
    expect(kernel.schema).toBeTruthy();
    expect(kernel.staging).toBeTruthy();
    expect(kernel.store).toBeTruthy();
    expect(kernel.thread).toBeTruthy();
    expect(kernel.tree).toBeTruthy();
    expect(kernel.turn).toBeTruthy();
    expect(kernel.verdicts).toBeTruthy();
  });

  test("verdicts.compose priority: abort wins over proceed", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      { kind: "proceed" },
      { disposition: "HardFail", kind: "abort", reason: "stop" },
    ]);
    expect(result.kind).toBe("abort");
  });

  test("verdicts.compose priority: abort wins over retry", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      { adjustment: {}, kind: "retry" },
      { disposition: "HardFail", kind: "abort", reason: "stop" },
    ]);
    expect(result.kind).toBe("abort");
  });

  test("verdicts.compose returns proceed when all proceed", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      { kind: "proceed" },
      { kind: "proceed" },
    ]);
    expect(result.kind).toBe("proceed");
  });

  test("run.completeStep advances a final step past the sequence", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_final_step",
      threadId: "thread_final_step",
    });
    const turn = await fixture.kernel.turn.create(
      "turn_final_step",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );
    await fixture.kernel.run.create(
      "run_final_step",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: true, id: "only", sideEffects: false }]
    );

    await fixture.kernel.run.beginStep("run_final_step", "only");
    await fixture.kernel.run.completeStep("run_final_step", "only");

    await expect(
      fixture.kernel.run.beginStep("run_final_step", "only")
    ).rejects.toThrow('unexpected step "only"');

    const recovery = await fixture.kernel.run.recover("run_final_step");
    expect(recovery.lastCompletedStepId).toBe("only");
  });

  test("thread.create rejects duplicate thread and initial branch ids without side effects", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_thread_uniqueness",
      now: () => 1,
      threadId: "thread_uniqueness",
    });

    await expect(
      fixture.kernel.thread.create(
        fixture.threadId,
        fixture.schemaId,
        "branch_shadow"
      )
    ).rejects.toThrow('thread "thread_uniqueness" already exists');

    expect(await fixture.kernel.branch.list(fixture.threadId)).toEqual([
      [fixture.branchId, fixture.rootTurnNodeHash],
    ]);

    await expect(
      fixture.kernel.thread.create(
        "thread_branch_collision",
        fixture.schemaId,
        fixture.branchId
      )
    ).rejects.toThrow('branch "branch_thread_uniqueness" already exists');
    expect(
      await fixture.kernel.thread.get("thread_branch_collision")
    ).toBeNull();
  });
});
