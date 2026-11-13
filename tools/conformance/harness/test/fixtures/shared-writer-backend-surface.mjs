import assert from "node:assert/strict";

import { createPostgresBackend } from "../../../../../typescript/kernel/backends/postgres/dist/index.js";
import { createRuntimeKernel } from "../../../../../typescript/kernel/runtime/dist/index.js";
import { selectKernelMutant } from "../../../../../typescript/kernel/testkit/dist/index.js";

const [storageRef] = process.argv.slice(2);
const inner = createPostgresBackend({
  database: storageRef,
  now: () => 200,
  schemaName: "tuvren_cert",
});

const verify = async (omitClock) => {
  const frozen = Object.freeze({
    capabilities: () => inner.capabilities(),
    health: async () => await inner.health(),
    transact: async (work) =>
      await inner.transact(async (tx) => {
        const { now: _now, ...repositories } = tx;
        return await work(omitClock ? repositories : tx);
      }),
  });
  const mutant = selectKernelMutant("kernel.accept-stale-shared-writer");
  const backend = mutant.wrapBackend(frozen);
  assert.deepEqual(backend.capabilities(), frozen.capabilities());
  assert.equal(Object.isFrozen(frozen), true);
  await backend.transact(async (tx) => {
    assert.equal(Object.hasOwn(tx, "now"), !omitClock);
    assert.equal(tx.now?.(), omitClock ? undefined : 200);
  });
  if (omitClock) return;
  const kernel = mutant.wrapKernel(
    createRuntimeKernel({ backend, now: () => 200 }),
    backend
  );
  const prefix = omitClock ? "without_clock" : "with_clock";
  const schema = await kernel.schema.register({
    incorporationRules: [{ objectType: "message", targetPath: "messages" }],
    paths: [{ collection: "ordered", path: "messages" }],
    schemaId: prefix,
  });
  const common = `${prefix}_common`;
  const thread = await kernel.thread.create(prefix, schema, common);
  const checkpoint = async (id) => {
    await kernel.branch.create(id, prefix, thread.rootTurnNodeHash);
    await kernel.turn.create(
      id,
      prefix,
      id,
      undefined,
      thread.rootTurnNodeHash
    );
    await kernel.run.create(id, id, id, schema, thread.rootTurnNodeHash, [
      { deterministic: false, id: "step", sideEffects: false },
    ]);
    await kernel.run.beginStep(id, "step");
    await kernel.staging.stage(
      id,
      new TextEncoder().encode(id),
      id,
      "message",
      "completed"
    );
    const result = await kernel.run.completeStep(id, "step");
    await kernel.run.complete(id, "completed");
    assert.equal(typeof result.turnNodeHash, "string");
    return result.turnNodeHash;
  };
  const a = await checkpoint(`${prefix}_a`);
  const b = await checkpoint(`${prefix}_b`);
  assert.notEqual(a, b);
  await kernel.branch.setHead(common, a);
  assert.equal(mutant.readActivation().activationCount, 0);
  assert.equal(mutant.readActivation().guardBypassCount, undefined);
  await assert.rejects(kernel.branch.setHead(common, b), {
    code: "kernel_runtime_lateral_head_movement",
  });
  assert.equal(mutant.readActivation().activationCount, 0);
  const contender = selectKernelMutant("kernel.accept-stale-shared-writer");
  const contenderBackend = contender.wrapBackend(frozen);
  const contenderKernel = contender.wrapKernel(
    createRuntimeKernel({ backend: contenderBackend, now: () => 200 }),
    contenderBackend
  );
  await contenderKernel.branch.setHead(common, b);
  assert.equal(contender.readActivation().activationCount, 1);
  assert.equal(contender.readActivation().guardBypassCount, 1);
  assert.equal(
    (await inner.transact(async (tx) => await tx.branches.get(common)))
      .headTurnNodeHash,
    b
  );
  await assert.rejects(contenderKernel.branch.setHead(common, "f".repeat(64)), {
    code: "kernel_runtime_missing_turn_node",
  });
  assert.equal(contender.readActivation().activationCount, 1);
};

try {
  await verify(false);
  await verify(true);
} finally {
  await inner.close();
}
