import assert from "node:assert/strict";

import { createPostgresBackend } from "../../../../../typescript/kernel/backends/postgres/dist/index.js";
import { createRuntimeKernel } from "../../../../../typescript/kernel/runtime/dist/index.js";
import { selectKernelMutant } from "../../../../../typescript/kernel/testkit/dist/index.js";

const [storageRef] = process.argv.slice(2);
const inner = createPostgresBackend({
  database: storageRef,
  schemaName: "tuvren_cert",
});
try {
  const mutant = selectKernelMutant("kernel.ignore-expired-lease-preemption");
  for (const omitClock of [false, true]) {
    const frozen = Object.freeze({
      capabilities: () => inner.capabilities(),
      health: async () => await inner.health(),
      transact: async (work) =>
        await inner.transact(async (tx) => {
          const { now: _now, ...repositories } = tx;
          return await work(omitClock ? repositories : tx);
        }),
    });
    const backend = mutant.wrapBackend(frozen);
    assert.equal(backend, frozen);
    await backend.transact(async (tx) => {
      assert.equal(Object.hasOwn(tx, "now"), !omitClock);
      await Promise.resolve();
    });
    if (omitClock) {
      continue;
    }
    const kernel = mutant.wrapKernel(
      createRuntimeKernel({ backend, now: () => 3_600_000 }),
      backend
    );
    const schema = await kernel.schema.register({
      schemaId: "lease",
      paths: [{ collection: "ordered", path: "messages" }],
      incorporationRules: [],
    });
    const runs = new Map();
    for (const [id, leaseExpiresAtMs] of [
      ["live", 7_200_000],
      ["expired", 0],
    ]) {
      const thread = await kernel.thread.create(id, schema, id);
      await kernel.turn.create(id, id, id, undefined, thread.rootTurnNodeHash);
      const run = await kernel.runLiveness.createLeasedRun({
        runId: id,
        turnId: id,
        branchId: id,
        schemaId: schema,
        startTurnNodeHash: thread.rootTurnNodeHash,
        steps: [{ id: "step", deterministic: false, sideEffects: true }],
        executionOwnerId: "original",
        leaseExpiresAtMs,
      });
      runs.set(id, run);
    }
    const measured = await backend.transact(async (tx) => {
      const live = await tx.runs.get("live");
      const expired = await tx.runs.get("expired");
      const serverNow = tx.now();
      assert.ok(expired.leaseExpiresAtMs < serverNow);
      assert.ok(live.leaseExpiresAtMs > serverNow);
      return { expired, serverNow };
    });
    await assert.rejects(
      kernel.runLiveness.preemptExpired(
        "live",
        "other",
        Number.MAX_SAFE_INTEGER,
        "test"
      ),
      { code: "kernel_runtime_run_lease_not_expired" }
    );
    assert.equal(mutant.readActivation().activationCount, 0);
    await assert.rejects(
      kernel.runLiveness.preemptExpired(
        "expired",
        "",
        Number.MAX_SAFE_INTEGER,
        "test"
      )
    );
    assert.equal(mutant.readActivation().activationCount, 0);
    const recovery = await kernel.runLiveness.preemptExpired(
      "expired",
      "other",
      Number.MAX_SAFE_INTEGER,
      "test"
    );
    assert.equal(
      recovery.lastTurnNodeHash,
      runs.get("expired").startTurnNodeHash
    );
    assert.equal(mutant.readActivation().activationCount, 1);
    await backend.transact(async (tx) => {
      assert.deepEqual(await tx.runs.get("expired"), measured.expired);
    });
    await assert.rejects(
      kernel.runLiveness.preemptExpired(
        "live",
        "other",
        Number.MAX_SAFE_INTEGER,
        "test"
      ),
      { code: "kernel_runtime_run_lease_not_expired" }
    );
    assert.equal(mutant.readActivation().activationCount, 1);
  }
} finally {
  await inner.close();
}
