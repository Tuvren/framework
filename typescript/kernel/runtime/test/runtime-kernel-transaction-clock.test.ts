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

import { expect, test } from "bun:test";

import { createMemoryBackend } from "@tuvren/backend-memory";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

import {
  createThreadFixture,
  rejectionOf,
  TEST_SCHEMA,
} from "./runtime-kernel-test-helpers.ts";

test("a shared clock stamps branch creation and the checkpoint in backend time", async () => {
  const memory = createMemoryBackend();
  let backendNow = 100;
  const backend: RuntimeBackend = {
    capabilities: () => ({
      ...memory.capabilities(),
      "shared-lease-clock": true,
    }),
    health: async () => await memory.health(),
    transact: async (work) =>
      await memory.transact(
        async (tx) => await work({ ...tx, now: () => backendNow })
      ),
  };
  const fixture = await createThreadFixture({ backend, now: () => 200 });
  const branch = await fixture.kernel.branch.create(
    "branch_clock_fork",
    fixture.threadId,
    fixture.rootTurnNodeHash
  );
  const turn = await fixture.kernel.turn.create(
    "turn_clock",
    fixture.threadId,
    branch.branchId,
    null,
    fixture.rootTurnNodeHash
  );
  await fixture.kernel.run.create(
    "run_clock",
    turn.turnId,
    branch.branchId,
    fixture.schemaId,
    fixture.rootTurnNodeHash,
    [{ deterministic: false, id: "checkpoint", sideEffects: false }]
  );
  const staged = await fixture.kernel.staging.stage(
    "run_clock",
    new Uint8Array([1, 2, 3]),
    "task_clock",
    "message",
    "completed"
  );
  const initial = await backend.transact(async (tx) => ({
    branch: await tx.branches.get(branch.branchId),
    object: await tx.objects.get(staged.objectHash),
    run: await tx.runs.get("run_clock"),
    schema: await tx.schemas.get(fixture.schemaId),
    thread: await tx.threads.get(fixture.threadId),
    turn: await tx.turns.get(turn.turnId),
  }));

  expect(initial.schema?.createdAtMs).toBe(100);
  expect(initial.thread?.createdAtMs).toBe(100);
  expect(initial.branch?.createdAtMs).toBe(100);
  expect(initial.branch?.updatedAtMs).toBe(100);
  expect(initial.turn?.createdAtMs).toBe(100);
  expect(initial.run?.createdAtMs).toBe(100);
  expect(initial.object?.createdAtMs).toBe(100);
  expect(staged.stagedResult.timestamp).toBe(100);

  backendNow = 110;
  const checkpoint = await fixture.kernel.run.completeStep(
    "run_clock",
    "checkpoint"
  );
  if (checkpoint.turnNodeHash === undefined) {
    throw new Error("expected checkpoint turn node");
  }
  const committed = await backend.transact(async (tx) => ({
    branch: await tx.branches.get(branch.branchId),
    node: await tx.turnNodes.get(checkpoint.turnNodeHash ?? ""),
    run: await tx.runs.get("run_clock"),
    turn: await tx.turns.get(turn.turnId),
  }));
  expect(committed.branch?.updatedAtMs).toBe(110);
  expect(committed.turn?.updatedAtMs).toBe(110);
  expect(committed.run?.updatedAtMs).toBe(110);
  expect(committed.node?.createdAtMs).toBe(110);
});

test("a backend without a shared clock keeps the injected clock even if tx.now exists", async () => {
  const memory = createMemoryBackend();
  const backend: RuntimeBackend = {
    capabilities: () => memory.capabilities(),
    health: async () => await memory.health(),
    transact: async (work) =>
      await memory.transact(
        async (tx) => await work({ ...tx, now: () => 100 })
      ),
  };
  const fixture = await createThreadFixture({ backend, now: () => 200 });
  const stored = await backend.transact(
    async (tx) => await tx.branches.get(fixture.branchId)
  );
  expect(stored?.createdAtMs).toBe(200);
  expect(stored?.updatedAtMs).toBe(200);
});

test("a backend advertising a shared clock must provide it", async () => {
  const memory = createMemoryBackend();
  const backend: RuntimeBackend = {
    capabilities: () => ({
      ...memory.capabilities(),
      "shared-lease-clock": true,
    }),
    health: async () => await memory.health(),
    transact: async (work) =>
      await memory.transact(async (tx) => {
        const { now: _now, ...repositories } = tx;
        return await work(repositories);
      }),
  };
  const kernel = createRuntimeKernel({ backend, now: () => 200 });
  const error = await rejectionOf(kernel.schema.register(TEST_SCHEMA));
  expect(error.message).toContain("shared-lease-clock");
});

test("reclamation requires the advertised transaction clock for its default horizon", async () => {
  const memory = createMemoryBackend();
  const reclaim = memory.reclaim?.bind(memory);
  if (reclaim === undefined) {
    throw new Error("memory backend does not support reclamation");
  }
  const backend: RuntimeBackend = {
    capabilities: () => ({
      ...memory.capabilities(),
      "shared-lease-clock": true,
    }),
    health: async () => await memory.health(),
    reclaim: async (options) => await reclaim(options),
    transact: async (work) =>
      await memory.transact(async (tx) => {
        const { now: _now, ...repositories } = tx;
        return await work(repositories);
      }),
  };
  const kernel = createRuntimeKernel({ backend, now: () => 200 });
  expect(await rejectionOf(kernel.maintenance.reclaim())).toMatchObject({
    code: "kernel_capability_unsupported",
  });
  expect(await kernel.maintenance.reclaim({ nowMs: 200 })).toMatchObject({
    releasedObjectCount: 0,
  });
});
