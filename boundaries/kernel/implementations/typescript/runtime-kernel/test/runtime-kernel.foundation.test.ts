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
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  createThreadFixture,
  TEST_SCHEMA,
} from "./runtime-kernel-test-helpers.ts";

describe("createRuntimeKernel foundation", () => {
  test("returns a truthy RuntimeKernel instance", () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    expect(kernel).toBeTruthy();
  });

  test("kernel has expected syscall namespaces", () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    expect(kernel.branch).toBeTruthy();
    expect(kernel.node).toBeTruthy();
    expect(kernel.run).toBeTruthy();
    expect(kernel.runLiveness).toBeTruthy();
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

  test("verdicts.compose preserves a single modify verdict unchanged", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { phase: "single" },
      },
    ]);

    expect(result).toEqual({
      kind: "modify",
      transform: { phase: "single" },
    });
  });

  test("verdicts.compose preserves multiple modify verdicts in registration order", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { phase: "first" },
      },
      { kind: "proceed" },
      {
        kind: "modify",
        transform: { phase: "second" },
      },
    ]);

    expect(result).toEqual({
      kind: "modify",
      transform: [{ phase: "first" }, { phase: "second" }],
    });
  });

  test("verdicts.compose keeps pause ahead of composed modify verdicts", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const result = await kernel.verdicts.compose([
      {
        kind: "modify",
        transform: { phase: "first" },
      },
      {
        kind: "pause",
        reason: "awaiting_approval",
        resumptionSchema: { type: "approval" },
      },
      {
        kind: "modify",
        transform: { phase: "second" },
      },
    ]);

    expect(result).toEqual({
      kind: "pause",
      reason: "awaiting_approval",
      resumptionSchema: { type: "approval" },
    });
  });

  test("schema.register rejects duplicate schema ids even for identical payloads", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });

    expect(await kernel.schema.register(TEST_SCHEMA)).toBe(
      TEST_SCHEMA.schemaId
    );
    await expect(kernel.schema.register(TEST_SCHEMA)).rejects.toThrow(
      `schema "${TEST_SCHEMA.schemaId}" is already registered`
    );
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

  test("branch.create rejects duplicate branch ids before writing", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_create_uniqueness",
      now: () => 1,
      threadId: "thread_branch_create_uniqueness",
    });

    await expect(
      fixture.kernel.branch.create(
        fixture.branchId,
        fixture.threadId,
        fixture.rootTurnNodeHash
      )
    ).rejects.toThrow('branch "branch_create_uniqueness" already exists');

    expect(await fixture.kernel.branch.list(fixture.threadId)).toEqual([
      [fixture.branchId, fixture.rootTurnNodeHash],
    ]);
  });

  test("turn.create rejects duplicate turn ids before writing", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_turn_uniqueness",
      now: () => 1,
      threadId: "thread_turn_uniqueness",
    });

    const turn = await fixture.kernel.turn.create(
      "turn_uniqueness",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );

    await expect(
      fixture.kernel.turn.create(
        turn.turnId,
        fixture.threadId,
        fixture.branchId,
        null,
        fixture.rootTurnNodeHash
      )
    ).rejects.toThrow('turn "turn_uniqueness" already exists');

    expect(await fixture.kernel.turn.get(turn.turnId)).toEqual(turn);
  });

  test("run.create rejects duplicate run ids before validation", async () => {
    const fixture = await createThreadFixture({
      branchId: "branch_run_uniqueness",
      now: () => 1,
      threadId: "thread_run_uniqueness",
    });

    const turn = await fixture.kernel.turn.create(
      "turn_run_uniqueness",
      fixture.threadId,
      fixture.branchId,
      null,
      fixture.rootTurnNodeHash
    );

    await fixture.kernel.run.create(
      "run_uniqueness",
      turn.turnId,
      fixture.branchId,
      fixture.schemaId,
      fixture.rootTurnNodeHash,
      [{ deterministic: true, id: "start", sideEffects: false }]
    );

    await expect(
      fixture.kernel.run.create(
        "run_uniqueness",
        turn.turnId,
        fixture.branchId,
        fixture.schemaId,
        fixture.rootTurnNodeHash,
        [{ deterministic: true, id: "start", sideEffects: false }]
      )
    ).rejects.toThrow('run "run_uniqueness" already exists');
  });
});
