import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { JsonRpcAdapterClient } from "../adapter-client.ts";
import { ProcessSupervisor } from "../process-supervisor.ts";
import { withCheckStorage } from "../storage-resource.ts";

const points = [
  "before-commit",
  "after-turn-node-write-before-head",
  "after-head-move-before-staging-clear",
  "after-commit-before-ack",
] as const;
const SQLITE_LOCKED = /locked|busy/iu;

const result = async (
  client: JsonRpcAdapterClient,
  instance: unknown,
  operation: string,
  input: unknown
): Promise<unknown> => {
  const outcome = await client.dispatch(operation, input, {}, instance);
  if (
    outcome.kind !== "result" ||
    typeof outcome.value !== "object" ||
    outcome.value === null ||
    !("result" in outcome.value)
  ) {
    throw new Error(`${operation} failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.value.result;
};

const checkpointSetup = async (
  client: JsonRpcAdapterClient,
  storageRef: string,
  steps = ["step"],
  existingInstance?: unknown
) => {
  const instance =
    existingInstance ?? (await client.createInstance({}, { storageRef }));
  for (const domain of ["backend", "worker"]) {
    await result(client, instance, "kernel.clock.set", { domain, nowMs: 200 });
  }
  await result(client, instance, "kernel.schema.register", {
    schema: {
      schemaId: "fault-schema",
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
    },
  });
  const thread = await result(client, instance, "kernel.thread.create", {
    threadId: "thread",
    schemaId: "fault-schema",
    initialBranchId: "branch",
  });
  if (
    typeof thread !== "object" ||
    thread === null ||
    !("rootTurnNodeHash" in thread)
  ) {
    throw new Error("missing root turn node");
  }
  await result(client, instance, "kernel.turn.create", {
    turnId: "turn",
    threadId: "thread",
    branchId: "branch",
    startTurnNodeHash: thread.rootTurnNodeHash,
  });
  await result(client, instance, "kernel.run.create", {
    runId: "run",
    turnId: "turn",
    branchId: "branch",
    schemaId: "fault-schema",
    startTurnNodeHash: thread.rootTurnNodeHash,
    steps: steps.map((id) => ({
      id,
      deterministic: false,
      sideEffects: false,
    })),
  });
  await result(client, instance, "kernel.run.beginStep", {
    runId: "run",
    stepId: "step",
  });
  await result(client, instance, "kernel.staging.stage", {
    runId: "run",
    blob: { $bytes: "01" },
    taskId: "task",
    objectType: "message",
    status: "completed",
  });
  return { instance, root: thread.rootTurnNodeHash };
};

const readHeadAndStaging = async (
  backend: string,
  storageRef: string
): Promise<string[]> => {
  const query =
    "SELECT head_turn_node_hash FROM branches WHERE branch_id = 'branch'; SELECT count(*) FROM staged_results;";
  if (backend === "sqlite") {
    const db = new Database(path.join(storageRef, "kernel.sqlite"), {
      readonly: true,
    });
    try {
      const head = db
        .query(
          "SELECT head_turn_node_hash AS head FROM branches WHERE branch_id = 'branch'"
        )
        .get();
      const staged = db
        .query("SELECT count(*) AS count FROM staged_results")
        .get();
      if (
        typeof head !== "object" ||
        head === null ||
        !("head" in head) ||
        typeof staged !== "object" ||
        staged === null ||
        !("count" in staged)
      ) {
        throw new Error("missing SQLite reader rows");
      }
      return [String(head.head), String(staged.count)];
    } finally {
      db.close();
    }
  }
  const { stdout } = await promisify(execFile)("psql", [
    "-X",
    "-A",
    "-t",
    "-d",
    storageRef,
    "-c",
    `SET search_path TO tuvren_cert; ${query}`,
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "SET");
};

const transactionIsOpen = async (
  backend: string,
  storageRef: string
): Promise<boolean> => {
  if (backend === "sqlite") {
    const db = new Database(path.join(storageRef, "kernel.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 0");
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        return false;
      } catch (error: unknown) {
        if (error instanceof Error && SQLITE_LOCKED.test(error.message)) {
          return true;
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }
  const { stdout } = await promisify(execFile)("psql", [
    "-X",
    "-A",
    "-t",
    "-d",
    storageRef,
    "-c",
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'",
  ]);
  return Number(stdout.trim()) > 0;
};

const waitForReceipt = async (
  client: JsonRpcAdapterClient,
  mark: ReturnType<JsonRpcAdapterClient["markTranscript"]>
) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const receipts = client
      .framesSince(mark)
      .filter(
        (entry) =>
          entry.direction === "receive" &&
          JSON.parse(entry.frame).method === "faultReached"
      );
    if (receipts.length > 0) {
      return receipts;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("faultReached notification timed out");
};

for (const [backend, kind] of [
  ["sqlite", "sqlite-directory"],
  ["postgres", "postgres-database"],
] as const) {
  test(`${backend} fault tokens distinguish instances in the same process`, async () => {
    await withCheckStorage(kind, async (storageRef) => {
      const supervisor = await ProcessSupervisor.start({
        executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
        args: ["--backend", backend],
        cwd: process.cwd(),
        packetId: "tuvren.kernel.protocol",
        planVersion: "0.1.0",
      });
      try {
        const first = await supervisor.client.createInstance(
          {},
          { storageRef }
        );
        const second = await supervisor.client.createInstance(
          {},
          { storageRef }
        );
        const a = await supervisor.client.armFault(
          first,
          "before-commit",
          {},
          1,
          "throw"
        );
        const b = await supervisor.client.armFault(
          second,
          "before-commit",
          {},
          1,
          "throw"
        );
        expect(a.token).not.toBe(b.token);
      } finally {
        await supervisor.close();
      }
    });
  }, 30_000);
  test(`${backend} can arm a live instance before clock configuration`, async () => {
    await withCheckStorage(kind, async (storageRef) => {
      const supervisor = await ProcessSupervisor.start({
        executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
        args: ["--backend", backend],
        cwd: process.cwd(),
        packetId: "tuvren.kernel.protocol",
        planVersion: "0.1.0",
      });
      try {
        const instance = await supervisor.client.createInstance(
          {},
          { storageRef }
        );
        const { token } = await supervisor.client.armFault(
          instance,
          "before-commit",
          {},
          1,
          "throw"
        );
        await checkpointSetup(
          supervisor.client,
          storageRef,
          ["step"],
          instance
        );
        expect(
          await supervisor.client.dispatch(
            "kernel.run.completeStep",
            { runId: "run", stepId: "step" },
            {},
            instance
          )
        ).toMatchObject({
          kind: "error",
          error: {
            code: "kernel_persistence_fault_injected",
            details: { token },
          },
        });
        await supervisor.client.destroyInstance(instance);
      } finally {
        await supervisor.close();
      }
    });
  }, 30_000);
  for (const point of points) {
    test(`${backend} ${point} emits one receipt and holds the operation at the real boundary`, async () => {
      await withCheckStorage(kind, async (storageRef) => {
        const supervisor = await ProcessSupervisor.start({
          executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
          args: ["--backend", backend],
          cwd: process.cwd(),
          packetId: "tuvren.kernel.protocol",
          planVersion: "0.1.0",
        });
        try {
          await supervisor.restart();
          const client = supervisor.client;
          const { instance, root } = await checkpointSetup(client, storageRef);
          const { token } = await client.armFault(
            instance,
            point,
            { operation: "checkpoint", branchId: "branch" },
            1,
            "block"
          );
          const mark = client.markTranscript();
          const started = await client.startOperation(
            "kernel.run.completeStep",
            { runId: "run", stepId: "step" },
            instance
          );
          const pending = client.awaitOperation(started.operationHandle).then(
            () => "settled",
            () => "settled"
          );
          const receipts = await waitForReceipt(client, mark);
          expect(JSON.parse(receipts[0]?.frame ?? "null")).toEqual({
            jsonrpc: "2.0",
            method: "faultReached",
            params: {
              token,
              processEpoch: supervisor.current.epoch,
              phase: point,
            },
          });
          await result(client, instance, "kernel.clock.set", {
            domain: "worker",
            nowMs: 201,
          });
          expect(
            await Promise.race([
              pending,
              new Promise((resolve) => setTimeout(() => resolve("held"), 50)),
            ])
          ).toBe("held");
          const [head, staged] = await readHeadAndStaging(backend, storageRef);
          expect(head === root).toBe(point !== "after-commit-before-ack");
          expect(staged).toBe(point === "after-commit-before-ack" ? "0" : "1");
          expect(await transactionIsOpen(backend, storageRef)).toBe(
            point !== "after-commit-before-ack"
          );
          expect(
            client
              .framesSince(mark)
              .filter(
                (entry) =>
                  entry.direction === "receive" &&
                  JSON.parse(entry.frame).method === "faultReached"
              )
          ).toHaveLength(1);
          await supervisor.kill();
          expect(supervisor.current.exit?.signal).toBe("SIGKILL");
          await pending;
          expect(await readHeadAndStaging(backend, storageRef)).toEqual([
            head,
            staged,
          ]);
        } finally {
          await supervisor.close();
        }
      });
    }, 30_000);

    test(`${backend} ${point} throw carries its token and preserves the commit boundary`, async () => {
      await withCheckStorage(kind, async (storageRef) => {
        const supervisor = await ProcessSupervisor.start({
          executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
          args: ["--backend", backend],
          cwd: process.cwd(),
          packetId: "tuvren.kernel.protocol",
          planVersion: "0.1.0",
        });
        try {
          const client = supervisor.client;
          const { instance, root } = await checkpointSetup(client, storageRef);
          const { token } = await client.armFault(
            instance,
            point,
            { operation: "checkpoint", branchId: "branch" },
            1,
            "throw"
          );
          const mark = client.markTranscript();
          expect(
            await client.dispatch(
              "kernel.run.completeStep",
              { runId: "run", stepId: "step" },
              {},
              instance
            )
          ).toMatchObject({
            kind: "error",
            error: {
              code: "kernel_persistence_fault_injected",
              details: { point, token },
            },
          });
          const [head, staged] = await readHeadAndStaging(backend, storageRef);
          expect(head === root).toBe(point !== "after-commit-before-ack");
          expect(staged).toBe(point === "after-commit-before-ack" ? "0" : "1");
          expect(
            client
              .framesSince(mark)
              .filter(
                (entry) =>
                  entry.direction === "receive" &&
                  JSON.parse(entry.frame).method === "faultReached"
              )
          ).toHaveLength(0);
        } finally {
          await supervisor.close();
        }
      });
    }, 30_000);
  }
  test(`${backend} rejects the uninstrumentable unknown commit outcome`, async () => {
    await withCheckStorage(kind, async (storageRef) => {
      const supervisor = await ProcessSupervisor.start({
        executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
        args: ["--backend", backend],
        cwd: process.cwd(),
        packetId: "tuvren.kernel.protocol",
        planVersion: "0.1.0",
      });
      try {
        const { instance } = await checkpointSetup(
          supervisor.client,
          storageRef
        );
        await expect(
          supervisor.client.armFault(
            instance,
            "commit-outcome-unknown",
            {},
            1,
            "block"
          )
        ).rejects.toMatchObject({
          envelope: { code: "kernel_fault_point_unsupported" },
        });
      } finally {
        await supervisor.close();
      }
    });
  }, 30_000);

  test(`${backend} matches the selector and counts matching checkpoint occurrences`, async () => {
    await withCheckStorage(kind, async (storageRef) => {
      const supervisor = await ProcessSupervisor.start({
        executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
        args: ["--backend", backend],
        cwd: process.cwd(),
        packetId: "tuvren.kernel.protocol",
        planVersion: "0.1.0",
      });
      try {
        const client = supervisor.client;
        const { instance } = await checkpointSetup(client, storageRef, [
          "step",
          "second",
          "third",
        ]);
        await client.armFault(
          instance,
          "before-commit",
          { branchId: "another-branch", operation: "checkpoint" },
          1,
          "throw"
        );
        await result(client, instance, "kernel.run.completeStep", {
          runId: "run",
          stepId: "step",
        });
        const { token } = await client.armFault(
          instance,
          "before-commit",
          { branchId: "branch", operation: "checkpoint" },
          2,
          "throw"
        );
        await result(client, instance, "kernel.run.completeStep", {
          runId: "run",
          stepId: "second",
        });
        expect(
          await client.dispatch(
            "kernel.run.completeStep",
            { runId: "run", stepId: "third" },
            {},
            instance
          )
        ).toMatchObject({
          kind: "error",
          error: {
            code: "kernel_persistence_fault_injected",
            details: { point: "before-commit", token },
          },
        });
        await result(client, instance, "kernel.run.completeStep", {
          runId: "run",
          stepId: "third",
        });
      } finally {
        await supervisor.close();
      }
    });
  }, 30_000);

  test(`${backend} public construction cannot activate the separately constructed seam`, async () => {
    await withCheckStorage(kind, async (storageRef) => {
      await promisify(execFile)("node", [
        "tools/conformance/harness/test/fixtures/durable-production-fault.mjs",
        backend,
        storageRef,
      ]);
    });
  }, 30_000);
}
