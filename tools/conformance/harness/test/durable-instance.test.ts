import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";
import {
  digestWorkspaceInputs,
  typescriptImplementationInputs,
} from "../../certification/provenance.ts";
import { loadConformancePlan } from "../../plan-compiler/index.ts";
import { JsonRpcAdapterClient } from "../adapter-client.ts";
import { descendantPids, ProcessSupervisor } from "../process-supervisor.ts";
import { withCheckStorage } from "../storage-resource.ts";

const SHA256 = /^[0-9a-f]{64}$/u;

test("implementation provenance includes the dynamically imported durable backend artifacts", async () => {
  const files = await typescriptImplementationInputs("sqlite-directory");
  const directFiles = files.filter(
    (file) => !file.split(path.sep).includes("node_modules")
  );
  const complete = await digestWorkspaceInputs(directFiles);
  for (const backend of ["sqlite", "postgres"]) {
    const artifact = path.resolve(
      `typescript/kernel/backends/${backend}/dist/index.js`
    );
    expect(files).toContain(artifact);
    expect(
      await digestWorkspaceInputs(
        directFiles.filter((file) => file !== artifact)
      )
    ).not.toBe(complete);
  }
}, 60_000);

const certificationDatabases = async (): Promise<string[]> => {
  const { stdout } = await promisify(execFile)("psql", [
    "-XAt",
    "-d",
    "postgres",
    "-c",
    "SELECT datname FROM pg_database WHERE starts_with(datname, 'tuvren_cert_') ORDER BY datname",
  ]);
  return stdout.trim() === "" ? [] : stdout.trim().split("\n");
};

test.each(["missing", "non-executable"])(
  "%s supervised executable is classified as environment",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "tuvren-executable-"));
    try {
      const executable = path.join(directory, "adapter");
      if (mode === "non-executable") {
        await writeFile(executable, "no execute permission");
        await chmod(executable, 0o644);
      }
      const manifest = JSON.parse(
        await readFile(
          "typescript/kernel/conformance-adapter/adapter-sqlite.json",
          "utf8"
        )
      );
      const manifestFile = path.join(directory, "adapter.json");
      await writeFile(
        manifestFile,
        JSON.stringify({ ...manifest, executable })
      );
      const runner = spawn({
        cmd: [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          manifestFile,
          "--check",
          "kernel.syscall.reopen.close_reopen_checkpoint",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(runner.stdout).text(),
        new Response(runner.stderr).text(),
        runner.exited,
      ]);
      expect(exit, stderr).toBe(1);
      expect(stdout, stderr).not.toBe("");
      const evidence: unknown = JSON.parse(stdout);
      assertConformanceEvidence(evidence, "unavailable adapter");
      expect(evidence.checkResults[0]).toMatchObject({
        failure: { classification: "environment" },
        assertionResults: [
          { message: expect.stringContaining("adapter executable") },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000
);

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
    const runner = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        `typescript/kernel/conformance-adapter/adapter-${backend}.json`,
        "--check",
        "kernel.syscall.reopen.close_reopen_checkpoint",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutResult = new Response(runner.stdout).text();
    const stderrResult = new Response(runner.stderr).text();
    let finished = false;
    const exitResult = runner.exited.then((exit) => {
      finished = true;
      return exit;
    });
    const observed = new Set<number>();
    const unexpectedChildren: number[] = [];
    while (!finished) {
      for (const pid of await descendantPids(runner.pid)) {
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
          () => ""
        );
        if (!command.includes("conformance-adapter/dist/host.mjs")) {
          continue;
        }
        observed.add(pid);
        unexpectedChildren.push(...(await descendantPids(pid)));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [stdout, stderr, exit] = await Promise.all([
      stdoutResult,
      stderrResult,
      exitResult,
    ]);
    expect(exit, stderr).toBe(0);
    expect(observed.size).toBeGreaterThanOrEqual(3);
    expect(unexpectedChildren).toEqual([]);
    const evidence: unknown = JSON.parse(stdout);
    assertConformanceEvidence(evidence, "reopen evidence");
    expect(evidence.status).toBe("pass");
    expect(evidence.checkResults).toHaveLength(1);
    for (const check of evidence.checkResults) {
      expect(check.status).toBe("pass");
      expect(check.details?.storageIdentity).toBeUndefined();
      expect(check.details?.process).toBeUndefined();
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
    expect(evidence.checkResults[0]?.details?.process).toBeUndefined();
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

test.each([
  ["sqlite", "sqlite-directory"],
  ["postgres", "postgres-database"],
] as const)(
  "%s adapter uses only harness storage and no children across process epochs",
  async (backend, kind) => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "tuvren-ownership-"));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = tempRoot;
    try {
      const initialEntries = await readdir(tempRoot);
      const initialDatabases = await certificationDatabases();
      await withCheckStorage(kind, async (storageRef) => {
        const provisionedEntries = await readdir(tempRoot);
        const provisionedDatabases = await certificationDatabases();
        expect(
          provisionedEntries.filter((name) => !initialEntries.includes(name))
        ).toEqual(
          kind === "sqlite-directory" ? [path.basename(storageRef)] : []
        );
        expect(
          provisionedDatabases.filter(
            (name) => !initialDatabases.includes(name)
          )
        ).toEqual(kind === "postgres-database" ? [storageRef] : []);
        const supervisor = await ProcessSupervisor.start({
          executable: "typescript/kernel/conformance-adapter/dist/host.mjs",
          args: ["--backend", backend],
          cwd: process.cwd(),
          packetId: "tuvren.kernel.protocol",
          planVersion: "0.1.0",
        });
        try {
          const firstPid = supervisor.current.pid;
          const firstEpoch = supervisor.current.epoch;
          const first = await supervisor.client.createInstance(
            {},
            { storageRef }
          );
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
          expect(await descendantPids(firstPid)).toEqual([]);
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
          expect(await descendantPids(supervisor.current.pid)).toEqual([]);
          expect(await readdir(tempRoot)).toEqual(provisionedEntries);
          expect(await certificationDatabases()).toEqual(provisionedDatabases);
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
      expect(await readdir(tempRoot)).toEqual(initialEntries);
      expect(await certificationDatabases()).toEqual(initialDatabases);
    } finally {
      if (previousTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmp;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
  30_000
);
