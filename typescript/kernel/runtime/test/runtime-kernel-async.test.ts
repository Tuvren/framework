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

import type { RuntimeBackend } from "@tuvren/kernel-protocol";

import { mapSequential, unfoldAsync } from "../src/lib/runtime-kernel-async.ts";
import { walkBack, walkBackFromTx } from "../src/lib/runtime-kernel-lineage.ts";
import { requireThreadTurnNode } from "../src/lib/runtime-kernel-storage.ts";
import {
  createThreadFixture,
  rejectionOf,
} from "./runtime-kernel-test-helpers.ts";

test("sequential mapping settles one effect before the next and closes its input on return", async () => {
  const effects: string[] = [];
  const input = function* input(): Generator<number, void, unknown> {
    try {
      yield 1;
      yield 2;
      yield 3;
    } finally {
      effects.push("closed");
    }
  };
  const mapped = mapSequential(input(), async (value) => {
    effects.push(`start:${value}`);
    await Promise.resolve();
    effects.push(`end:${value}`);
    return value;
  });
  expect(effects).toEqual([]);
  const [first, second] = await Promise.all([mapped.next(), mapped.next()]);
  expect(first).toEqual({ done: false, value: 1 });
  expect(second).toEqual({ done: false, value: 2 });
  expect(effects).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  await mapped.return();
  expect(effects).toEqual(["start:1", "end:1", "start:2", "end:2", "closed"]);
  expect(await mapped.next()).toEqual({ done: true, value: undefined });
});

test("sequential mapping preserves rejection identity and starts no later effect", async () => {
  const effects: number[] = [];
  const failure = new Error("write failed");
  const mapped = mapSequential([1, 2, 3], async (value) => {
    effects.push(value);
    await Promise.resolve();
    if (value === 2) {
      throw failure;
    }
    return value;
  });
  await mapped.next();
  expect(await rejectionOf(mapped.next())).toBe(failure);
  expect(await mapped.next()).toEqual({ done: true, value: undefined });
  expect(effects).toEqual([1, 2]);
});

test("state unfolding serializes concurrent pulls without prefetch and preserves thrown errors", async () => {
  const states: number[] = [];
  const values = unfoldAsync(0, async (state) => {
    states.push(state);
    await Promise.resolve();
    return { next: state + 1, value: state };
  });
  expect(states).toEqual([]);
  expect(await Promise.all([values.next(), values.next()])).toEqual([
    { done: false, value: 0 },
    { done: false, value: 1 },
  ]);
  expect(states).toEqual([0, 1]);
  const failure = new Error("consumer stopped");
  expect(await rejectionOf(values.throw(failure))).toBe(failure);
  expect(await values.next()).toEqual({ done: true, value: undefined });
  expect(states).toEqual([0, 1]);
});

test("state unfolding stops on null or rejection and operates with constant stack depth", async () => {
  const values = unfoldAsync(0, async (state) => {
    await Promise.resolve();
    return state === 20_000 ? null : { next: state + 1, value: state };
  });
  let count = 0;
  let last = -1;
  for await (const value of values) {
    count += 1;
    last = value;
  }
  expect(count).toBe(20_000);
  expect(last).toBe(19_999);
  expect(await values.next()).toEqual({ done: true, value: undefined });

  const states: number[] = [];
  const failure = new Error("read failed");
  const rejected = unfoldAsync(1, async (state) => {
    states.push(state);
    await Promise.resolve();
    throw failure;
  });
  expect(await rejectionOf(rejected.next())).toBe(failure);
  expect(await rejected.next()).toEqual({ done: true, value: undefined });
  expect(states).toEqual([1]);
});

test("lineage walking stays lazy, performs its original initial reread, and stops on return", async () => {
  const fixture = await createThreadFixture();
  const turn = await fixture.kernel.turn.create(
    "turn_lazy",
    fixture.threadId,
    fixture.branchId,
    null,
    fixture.rootTurnNodeHash
  );
  await fixture.kernel.run.create(
    "run_lazy",
    turn.turnId,
    fixture.branchId,
    fixture.schemaId,
    fixture.rootTurnNodeHash,
    [{ deterministic: false, id: "checkpoint", sideEffects: false }]
  );
  const checkpoint = await fixture.kernel.run.completeStep(
    "run_lazy",
    "checkpoint"
  );
  if (checkpoint.turnNodeHash === undefined) {
    throw new Error("expected checkpoint node");
  }
  const headHash = checkpoint.turnNodeHash;
  const reads: string[] = [];
  const backend: RuntimeBackend = {
    capabilities: () => fixture.backend.capabilities(),
    health: async () => await fixture.backend.health(),
    transact: async (work) =>
      await fixture.backend.transact(
        async (tx) =>
          await work({
            ...tx,
            turnNodes: {
              ...tx.turnNodes,
              get: async (hash) => {
                reads.push(hash);
                return await tx.turnNodes.get(hash);
              },
            },
          })
      ),
  };
  const walker = walkBack(backend, headHash)[Symbol.asyncIterator]();
  expect(reads).toEqual([]);
  const first = await walker.next();
  if (first.done === true) {
    throw new Error("expected first node");
  }
  expect(first.value.hash).toBe(headHash);
  expect(reads).toEqual([headHash, headHash]);
  if (walker.return === undefined) {
    throw new Error("expected generator return");
  }
  await walker.return();
  expect(await walker.next()).toEqual({ done: true, value: undefined });
  expect(reads).toEqual([headHash, headHash]);

  const completeWalk = walkBack(backend, headHash);
  reads.length = 0;
  const hashes: string[] = [];
  for await (const node of completeWalk) {
    hashes.push(node.hash);
  }
  expect(hashes).toEqual([headHash, fixture.rootTurnNodeHash]);
  expect(reads).toEqual([headHash, headHash, fixture.rootTurnNodeHash]);

  const missing = walkBack(backend, "missing")[Symbol.asyncIterator]();
  const failure = await rejectionOf(missing.next());
  expect(failure.message).toBe('unknown turn node "missing"');
  expect(failure).toMatchObject({ code: "kernel_runtime_missing_turn_node" });
});

test("transaction lineage walks preserve missing-node errors and the matching-node reread", async () => {
  const fixture = await createThreadFixture();
  await fixture.backend.transact(async (tx) => {
    const reads: string[] = [];
    const instrumented = {
      ...tx,
      turnNodes: {
        ...tx.turnNodes,
        get: async (hash: string) => {
          reads.push(hash);
          return await tx.turnNodes.get(hash);
        },
      },
    };
    const node = await requireThreadTurnNode(
      instrumented,
      fixture.rootTurnNodeHash,
      {
        rootTurnNodeHash: fixture.rootTurnNodeHash,
        schemaId: fixture.schemaId,
        threadId: fixture.threadId,
      }
    );
    expect(node.hash).toBe(fixture.rootTurnNodeHash);
    expect(reads).toEqual([fixture.rootTurnNodeHash, fixture.rootTurnNodeHash]);
    const missing = walkBackFromTx(instrumented, "missing")[
      Symbol.asyncIterator
    ]();
    const failure = await rejectionOf(missing.next());
    expect(failure.message).toBe('unknown turn node "missing"');
    expect(failure).toMatchObject({ code: "kernel_runtime_missing_turn_node" });
  });
});

test("verdict composition keeps priority and rejects with the original evaluation error", async () => {
  const fixture = await createThreadFixture();
  const proceed = { kind: "proceed" } as const;
  const retry = { adjustment: null, kind: "retry" } as const;
  const modify = { kind: "modify", transform: { note: "changed" } } as const;
  const pause = {
    kind: "pause",
    reason: "wait",
    resumptionSchema: null,
  } as const;
  const abort = {
    disposition: "HardFail",
    kind: "abort",
    reason: "stop",
  } as const;
  expect(await fixture.kernel.verdicts.compose([])).toEqual(proceed);
  expect(await fixture.kernel.verdicts.compose([proceed, retry])).toBe(retry);
  expect(await fixture.kernel.verdicts.compose([retry, modify])).toEqual(
    modify
  );
  expect(await fixture.kernel.verdicts.compose([modify, pause])).toBe(pause);
  expect(await fixture.kernel.verdicts.compose([pause, abort])).toBe(abort);
  expect(await fixture.kernel.verdicts.compose([modify, modify])).toEqual({
    kind: "modify",
    transform: [modify.transform, modify.transform],
  });

  const failure = new Error("malformed verdict kind");
  const malformed = {
    get kind(): "proceed" {
      throw failure;
    },
  };
  const operation = fixture.kernel.verdicts.compose([malformed]);
  expect(operation).toBeInstanceOf(Promise);
  expect(await rejectionOf(operation)).toBe(failure);
});
