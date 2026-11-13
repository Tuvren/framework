import assert from "node:assert/strict";

import { createPostgresBackend } from "../../../../../typescript/kernel/backends/postgres/dist/index.js";
import { createSqliteBackend } from "../../../../../typescript/kernel/backends/sqlite/dist/index.js";
import { createRuntimeKernel } from "../../../../../typescript/kernel/runtime/dist/index.js";
import { selectKernelMutant } from "../../../../../typescript/kernel/testkit/dist/index.js";

const [backendName, storageRef] = process.argv.slice(2);
const inner =
  backendName === "sqlite"
    ? createSqliteBackend({
        databasePath: `${storageRef}/surface.sqlite`,
        now: () => 200,
      })
    : createPostgresBackend({
        database: storageRef,
        now: () => 200,
        schemaName: "tuvren_cert",
      });

try {
  for (const defect of [
    "committed-state",
    "checkpoint-lineage",
    "recovery-head",
    "completed-step",
  ]) {
    const mutant = selectKernelMutant(`kernel.reload-loses-${defect}`);
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
      assert.deepEqual(backend.capabilities(), inner.capabilities());
      assert.equal(Object.isFrozen(frozen), true);
      await backend.transact(async (tx) => {
        assert.equal(Object.hasOwn(tx, "now"), !omitClock);
        assert.equal(tx.now?.(), omitClock ? undefined : 200);
        await Promise.resolve();
      });
      if (omitClock) {
        continue;
      }
      const kernel = mutant.wrapKernel(
        createRuntimeKernel({ backend, now: () => 200 }),
        backend
      );
      const prefix = `${defect}_${omitClock}`;
      const schema = await kernel.schema.register({
        schemaId: prefix,
        incorporationRules: [{ objectType: "message", targetPath: "messages" }],
        paths: [{ collection: "ordered", path: "messages" }],
      });
      const thread = await kernel.thread.create(prefix, schema, prefix);
      await kernel.turn.create(
        prefix,
        prefix,
        prefix,
        undefined,
        thread.rootTurnNodeHash
      );
      await kernel.run.create(
        prefix,
        prefix,
        prefix,
        schema,
        thread.rootTurnNodeHash,
        [{ id: "step", deterministic: false, sideEffects: false }]
      );
      await kernel.run.beginStep(prefix, "step");
      await kernel.staging.stage(
        prefix,
        Uint8Array.of(1),
        prefix,
        "message",
        "completed"
      );
      const checkpoint = await kernel.run.completeStep(prefix, "step");
      const recovery = await kernel.run.recover(prefix);
      assert.equal(recovery.lastTurnNodeHash, checkpoint.turnNodeHash);
      assert.equal(recovery.lastCompletedStepId, "step");
      const node = await kernel.node.get(checkpoint.turnNodeHash);
      assert.equal(node.previousTurnNodeHash, thread.rootTurnNodeHash);
      assert.equal(
        (await kernel.tree.resolve(node.turnTreeHash, "messages")).length,
        1
      );
      const lineage = [];
      for await (const entry of kernel.node.walkBack(checkpoint.turnNodeHash)) {
        lineage.push(entry);
      }
      assert.equal(lineage.length, 2);
      assert.equal(mutant.readActivation().activationCount, 0);
    }
  }
} finally {
  await inner.close();
}
