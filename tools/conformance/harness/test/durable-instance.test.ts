import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { JsonRpcAdapterClient } from "../adapter-client.ts";
import { ProcessSupervisor } from "../process-supervisor.ts";
import { withCheckStorage } from "../storage-resource.ts";

const SHA256 = /^[0-9a-f]{64}$/u;

test.each([
  ["sqlite", "sqlite-directory"],
  ["postgres", "postgres-database"],
] as const)(
  "%s openInstance reads a previous instance's writes",
  async (backend, kind) => {
    await withCheckStorage(kind, async (storageRef) => {
      const client = new JsonRpcAdapterClient({
        command: [
          "node",
          "typescript/kernel/conformance-adapter/dist/host.mjs",
          "--backend",
          backend,
        ],
        cwd: process.cwd(),
      });
      try {
        await client.initialize("tuvren.kernel.protocol", "0.1.0");
        await expect(
          client.createInstance({}, { storageRef, clock: { nowMs: 100 } })
        ).rejects.toThrow("initial clock configuration is not specified");
        const scope = "tuvren.scope.durable-test";
        const first = await client.createInstance({}, { storageRef, scope });
        await client.dispatch(
          "kernel.clock.set",
          { domain: "backend", nowMs: 100 },
          {},
          first
        );
        await client.dispatch(
          "kernel.clock.set",
          { domain: "worker", nowMs: 200 },
          {},
          first
        );
        const bytes = { $bytes: "cafe" };
        const put = await client.dispatch(
          "kernel.store.put",
          { blob: bytes },
          {},
          first
        );
        if (
          put.kind !== "result" ||
          typeof put.value !== "object" ||
          put.value === null ||
          !("result" in put.value)
        ) {
          throw new Error("store.put did not return a hash");
        }
        const hash = put.value.result;
        await client.destroyInstance(first);
        const reopened = await client.openInstance(storageRef, scope);
        await client.dispatch(
          "kernel.clock.set",
          { domain: "backend", nowMs: 100 },
          {},
          reopened
        );
        await client.dispatch(
          "kernel.clock.set",
          { domain: "worker", nowMs: 200 },
          {},
          reopened
        );
        expect(
          await client.dispatch("kernel.store.get", { hash }, {}, reopened)
        ).toEqual({
          kind: "result",
          value: { result: bytes },
        });
        await client.destroyInstance(reopened);
      } finally {
        await client.shutdown();
      }
    });
  },
  30_000
);

test.each(["sqlite", "postgres"])(
  "%s syscall reopen plans run through supervised processes",
  async (backend) => {
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "tools/conformance/harness/run.ts",
        "--adapter",
        `typescript/kernel/conformance-adapter/adapter-${backend}.json`,
        "--check",
        "kernel.syscall.reopen.close_reopen_checkpoint",
        "--check",
        "kernel.syscall.reopen.invalid_staged_result",
      ],
      { cwd: process.cwd(), maxBuffer: 10_000_000 }
    );
    const evidence: unknown = JSON.parse(stdout);
    assertConformanceEvidence(evidence, "reopen evidence");
    expect(evidence.status).toBe("pass");
    expect(evidence.checkResults).toHaveLength(2);
    for (const check of evidence.checkResults) {
      expect(check.status).toBe("pass");
      expect(check.details?.storageIdentity).toMatchObject({
        kind: backend === "sqlite" ? "sqlite-directory" : "postgres-database",
        storageRef: expect.any(String),
      });
      const process = check.details?.process;
      expect(process).toMatchObject({
        epochs: [
          {
            epoch: 1,
            pid: expect.any(Number),
            exit: { code: 0, signal: null },
            executableDigest: expect.stringMatching(SHA256),
          },
          {
            epoch: 2,
            pid: expect.any(Number),
            exit: { code: 0, signal: null },
            executableDigest: expect.stringMatching(SHA256),
          },
        ],
      });
      if (
        typeof process !== "object" ||
        process === null ||
        !("epochs" in process) ||
        !Array.isArray(process.epochs)
      ) {
        throw new Error("missing process epochs");
      }
      expect(process.epochs[0]?.pid).not.toBe(process.epochs[1]?.pid);
    }
  },
  60_000
);

test("kill and respawn plan steps reopen the same storage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tuvren-kill-plan-"));
  try {
    const original = await loadConformancePlan(
      "spec/conformance/kernel/plans/kernel-close-reopen-syscall.json"
    );
    const source = original.plan.checks[0];
    if (source?.steps === undefined) {
      throw new Error("reopen trace is missing");
    }
    const check = structuredClone(source);
    const steps = check.steps;
    if (steps === undefined) {
      throw new Error("reopen steps are missing");
    }
    check.checkId = "kernel.syscall.reopen.kill_respawn_test";
    const index = steps.findIndex((step) => step.stepId === "restart");
    const restart = steps[index];
    if (index < 0 || restart === undefined) {
      throw new Error("restart step missing");
    }
    steps.splice(
      index,
      1,
      {
        ...restart,
        stepId: "kill",
        action: "kill",
        operation: "kernel.process.kill",
        capture: [{ name: "killReceipt", path: "result" }],
      },
      {
        ...restart,
        stepId: "respawn",
        action: "respawn",
        operation: "kernel.process.respawn",
      }
    );
    check.assertions.push({
      kind: "resultField",
      field: "$.trace.kill.result",
      equalsPath: "$.capture.killReceipt",
    });
    check.assertions.push({
      kind: "arrival",
      path: "$.arrivals.baselineStaged",
      lessThan: "$.arrivals.durableHead",
    });
    const plan = path.join(directory, "plan.json");
    await writeFile(
      plan,
      JSON.stringify({
        ...original.plan,
        planId: "tuvren.kernel.kill-respawn.test",
        checks: [check],
      })
    );
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "tools/conformance/harness/run.ts",
        "--adapter",
        "typescript/kernel/conformance-adapter/adapter-sqlite.json",
        "--plan",
        plan,
        "--check",
        check.checkId,
      ],
      { cwd: process.cwd(), maxBuffer: 10_000_000 }
    );
    const evidence: unknown = JSON.parse(stdout);
    assertConformanceEvidence(evidence, "kill and respawn evidence");
    expect(evidence.status).toBe("pass");
    expect(evidence.checkResults[0]?.details?.process).toMatchObject({
      epochs: [
        { epoch: 1, signal: "SIGKILL", exit: { signal: "SIGKILL" } },
        { epoch: 2, exit: { code: 0, signal: null } },
      ],
    });
    const kill = steps[index];
    if (kill === undefined) {
      throw new Error("kill step missing");
    }
    kill.assertions = [{ kind: "resultField", field: "$", notEquals: {} }];
    await writeFile(
      plan,
      JSON.stringify({
        ...original.plan,
        planId: "tuvren.kernel.kill-respawn.test",
        checks: [check],
      })
    );
    const failed = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        "typescript/kernel/conformance-adapter/adapter-sqlite.json",
        "--plan",
        plan,
        "--check",
        check.checkId,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [failedOutput, failedError, exit] = await Promise.all([
      new Response(failed.stdout).text(),
      new Response(failed.stderr).text(),
      failed.exited,
    ]);
    expect(exit, failedError).toBe(1);
    const failure: unknown = JSON.parse(failedOutput);
    assertConformanceEvidence(failure, "lifecycle assertion failure");
    expect(failure.checkResults[0]?.failure?.storageRef).toEqual(
      expect.any(String)
    );
    expect(failure.checkResults[0]?.assertionResults).toContainEqual(
      expect.objectContaining({
        assertionId: expect.stringContaining(".kill."),
        status: "fail",
      })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("supervisor respawns a killed adapter with a new PID and epoch on retained storage", async () => {
  await withCheckStorage("sqlite-directory", async (storageRef) => {
    const supervisor = await ProcessSupervisor.start({
      executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
      args: ["--backend", "sqlite"],
      cwd: process.cwd(),
      packetId: "tuvren.kernel.protocol",
      planVersion: "0.1.0",
    });
    try {
      const firstPid = supervisor.current.pid;
      const firstEpoch = supervisor.current.epoch;
      const first = await supervisor.client.createInstance({}, { storageRef });
      await supervisor.client.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: 100 },
        {},
        first
      );
      await supervisor.client.dispatch(
        "kernel.clock.set",
        { domain: "worker", nowMs: 200 },
        {},
        first
      );
      const bytes = { $bytes: "deadbeef" };
      const put = await supervisor.client.dispatch(
        "kernel.store.put",
        { blob: bytes },
        {},
        first
      );
      if (
        put.kind !== "result" ||
        typeof put.value !== "object" ||
        put.value === null ||
        !("result" in put.value)
      ) {
        throw new Error("store.put did not return a hash");
      }
      const hash = put.value.result;
      expect(
        (
          await readFile(`/proc/${firstPid}/task/${firstPid}/children`, "utf8")
        ).trim()
      ).toBe("");
      await supervisor.kill();
      await supervisor.respawn();
      expect(supervisor.current.pid).not.toBe(firstPid);
      expect(supervisor.current.epoch).not.toBe(firstEpoch);
      expect(supervisor.history[0]).toMatchObject({
        pid: firstPid,
        epoch: firstEpoch,
        signal: "SIGKILL",
        exit: { signal: "SIGKILL" },
      });
      expect(supervisor.current.executableDigest).toMatch(SHA256);
      const reopened = await supervisor.client.openInstance(storageRef);
      await supervisor.client.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: 100 },
        {},
        reopened
      );
      await supervisor.client.dispatch(
        "kernel.clock.set",
        { domain: "worker", nowMs: 200 },
        {},
        reopened
      );
      expect(
        await supervisor.client.dispatch(
          "kernel.store.get",
          { hash },
          {},
          reopened
        )
      ).toEqual({ kind: "result", value: { result: bytes } });
      const frames = supervisor.frames();
      expect(
        frames.every(
          (frame, index) =>
            index === 0 || frame.atMs >= (frames[index - 1]?.atMs ?? 0)
        )
      ).toBe(true);
    } finally {
      await supervisor.close();
    }
  });
}, 30_000);
