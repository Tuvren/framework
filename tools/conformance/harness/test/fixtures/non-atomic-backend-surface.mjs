import assert from "node:assert/strict";
import path from "node:path";

import { createPostgresBackend } from "../../../../../typescript/kernel/backends/postgres/dist/index.js";
import { createSqliteBackend } from "../../../../../typescript/kernel/backends/sqlite/dist/index.js";
import { selectKernelMutant } from "../../../../../typescript/kernel/testkit/dist/index.js";

const [kind, storageRef] = process.argv.slice(2);
const backend =
  kind === "sqlite"
    ? createSqliteBackend({
        databasePath: path.join(storageRef, "kernel.sqlite"),
        now: () => 200,
      })
    : createPostgresBackend({
        database: storageRef,
        now: () => 200,
        schemaName: "tuvren_cert",
      });

const verifyClock = async (omitClock) => {
  const frozen = Object.freeze({
    capabilities: () => backend.capabilities(),
    health: async () => await backend.health(),
    transact: async (work) =>
      await backend.transact(async (tx) => {
        const { now: _now, ...repositories } = tx;
        return await work(omitClock ? repositories : tx);
      }),
  });
  const mutant = selectKernelMutant("kernel.non-atomic-checkpoint");
  const wrapped = mutant.wrapBackend(frozen);
  mutant.wrapFaultInjection((inner) => inner)(wrapped, {
    occurrence: 1,
    point: "before-commit",
    policy: "once",
    token: "surface-probe",
  });
  assert.deepEqual(wrapped.capabilities(), frozen.capabilities());
  assert.equal(Object.isFrozen(frozen), true);
  await wrapped.transact(async (tx) => {
    assert.equal(Object.hasOwn(tx, "now"), !omitClock);
    assert.equal(tx.now?.(), omitClock ? undefined : 200);
    assert.equal(await tx.branches.get("absent"), null);
    assert.deepEqual(await tx.runs.listExpired(200), []);
    assert.equal(tx.now?.(), omitClock ? undefined : 200);
  });
  assert.equal(mutant.readActivation().activationCount, 0);
};

try {
  await verifyClock(false);
  await verifyClock(true);
} finally {
  await backend.close();
}
