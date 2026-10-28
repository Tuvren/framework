import assert from "node:assert/strict";
import path from "node:path";

import { createPostgresBackend } from "../../../../../typescript/kernel/backends/postgres/dist/index.js";
import { createSqliteBackend } from "../../../../../typescript/kernel/backends/sqlite/dist/index.js";
import { createRuntimeKernel } from "../../../../../typescript/kernel/runtime/dist/index.js";
import { createDurableFaultControl } from "../../../../../typescript/kernel/testkit/dist/index.js";

const [kind, storageRef] = process.argv.slice(2);
const backend =
  kind === "sqlite"
    ? createSqliteBackend({
        databasePath: path.join(storageRef, "kernel.sqlite"),
        now: () => 200,
      })
    : createPostgresBackend({
        database: storageRef,
        schemaName: "tuvren_cert",
        now: () => 200,
      });

try {
  const control = createDurableFaultControl(backend, () =>
    Promise.reject(new Error("unexpected receipt"))
  );
  const { token } = control.arm(
    "before-commit",
    { branchId: "branch", operation: "checkpoint" },
    1,
    "throw"
  );
  const production = createRuntimeKernel({ backend, now: () => 200 });
  const schema = await production.schema.register({
    schemaId: "schema",
    incorporationRules: [],
    paths: [{ path: "messages", collection: "ordered" }],
  });
  const thread = await production.thread.create("thread", schema, "branch");
  await production.turn.create(
    "turn",
    "thread",
    "branch",
    null,
    thread.rootTurnNodeHash
  );
  await production.run.create(
    "run",
    "turn",
    "branch",
    schema,
    thread.rootTurnNodeHash,
    [
      { id: "first", deterministic: false, sideEffects: false },
      { id: "second", deterministic: false, sideEffects: false },
    ]
  );
  const first = await control.runCheckpoint(
    async () => await production.run.completeStep("run", "first")
  );
  assert.equal(first.checkpointed, true);
  const instrumented = createRuntimeKernel({
    backend: control.backend,
    now: () => 200,
  });
  await assert.rejects(
    control.runCheckpoint(
      async () => await instrumented.run.completeStep("run", "second")
    ),
    {
      code: "kernel_persistence_fault_injected",
      details: { point: "before-commit", token },
    }
  );
} finally {
  await backend.close();
}
