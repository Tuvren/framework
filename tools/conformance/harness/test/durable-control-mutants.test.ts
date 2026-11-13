import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build, spawn } from "bun";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";
import type { ConformanceCheckResult } from "../../../scripts/lib/conformance-contract.ts";
import { withCheckStorage } from "../storage-resource.ts";

const MUTANT = "kernel.non-atomic-checkpoint";
const points = [
  ["before-commit", "before_commit"],
  ["after-turn-node-write-before-head", "after_turn_node_write_before_head"],
  [
    "after-head-move-before-staging-clear",
    "after_head_move_before_staging_clear",
  ],
] as const;

const field = (value: unknown, ...keys: readonly string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
};

const runCheck = async (
  adapter: string,
  checkId: string,
  expectedExit: 0 | 1,
  mutantId = MUTANT
): Promise<ConformanceCheckResult> => {
  const child = spawn({
    cmd: [
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapter,
      "--check",
      checkId,
      "--capture-observations",
    ],
    env: { ...process.env, TUVREN_KERNEL_MUTANT: mutantId },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(expectedExit);
  const evidence: unknown = JSON.parse(stdout);
  assertConformanceEvidence(evidence, "durable negative control");
  expect(evidence.checkResults).toHaveLength(1);
  const [check] = evidence.checkResults;
  if (check === undefined) {
    throw new Error("missing checkpoint check");
  }
  expect(check.checkId).toBe(checkId);
  return check;
};

const assertFaultReceipt = (
  check: ConformanceCheckResult,
  point: string
): void => {
  const fault = check.details?.fault;
  const token = field(fault, "armed", "0", "token");
  expect(typeof token).toBe("string");
  expect(field(fault, "armed")).toEqual([
    expect.objectContaining({ epoch: 1, mode: "block", point, token }),
  ]);
  expect(field(fault, "receipts")).toEqual([
    expect.objectContaining({ phase: point, processEpoch: 1, token }),
  ]);
  expect(field(fault, "activations")).toEqual([token]);
  expect(check.details?.process).toMatchObject({
    epochs: [
      { epoch: 1, exit: { code: null, signal: "SIGKILL" }, signal: "SIGKILL" },
      { epoch: 2, exit: { code: 0, signal: null } },
    ],
  });
};

const probeManifest = async (
  backend: string,
  directory: string
): Promise<string> => {
  const manifest: unknown = JSON.parse(
    await readFile(
      `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
      "utf-8"
    )
  );
  const command = field(manifest, "command");
  const executable = field(manifest, "executable");
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    typeof executable !== "string" ||
    !Array.isArray(command) ||
    !command.every((arg: unknown) => typeof arg === "string")
  ) {
    throw new TypeError("invalid mutant adapter manifest");
  }
  const manifestPath = path.join(directory, "adapter.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      command: [
        process.execPath,
        "tools/conformance/meta-conformance/activation-probe.ts",
        "--record",
        directory,
        "--operation",
        "kernel.mutant.activation",
        "--",
        executable,
        ...command.slice(1),
      ],
      executable: process.execPath,
    })
  );
  return manifestPath;
};

for (const backend of ["sqlite", "postgres"]) {
  test(`${backend} armed checkpoint does not affect a later reclamation check in the same process`, async () => {
    const child = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
        "--check",
        "kernel.syscall.controls.before_commit",
        "--check",
        "kernel.reclamation.unreachable_past_grace_is_released",
        "--concurrency",
        "1",
      ],
      env: { ...process.env, TUVREN_KERNEL_MUTANT: MUTANT },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const evidence: unknown = JSON.parse(stdout);
    assertConformanceEvidence(evidence, "checkpoint scope regression");
    expect(
      evidence.checkResults.map(({ checkId, status }) => ({ checkId, status }))
    ).toEqual([
      { checkId: "kernel.syscall.controls.before_commit", status: "pass" },
      {
        checkId: "kernel.reclamation.unreachable_past_grace_is_released",
        status: "pass",
      },
    ]);
  }, 90_000);

  test(`${backend} non-atomic checkpoint preserves frozen backend capabilities and optional transaction clocks`, async () => {
    await withCheckStorage(
      backend === "sqlite" ? "sqlite-directory" : "postgres-database",
      async (storageRef) => {
        const child = spawn({
          cmd: [
            "node",
            "tools/conformance/harness/test/fixtures/non-atomic-backend-surface.mjs",
            backend,
            storageRef,
          ],
          stderr: "pipe",
          stdout: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit, stderr).toBe(0);
        expect(stdout).toBe("");
      }
    );
  }, 30_000);

  test(`${backend} non-atomic checkpoint commits the dependent tail before the post-commit fault`, async () => {
    const check = await runCheck(
      `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
      "kernel.syscall.process-crash.after_commit_before_ack",
      0
    );
    expect(check.status).toBe("pass");
    assertFaultReceipt(check, "after-commit-before-ack");
  }, 90_000);

  for (const [point, suffix] of points) {
    test(`${backend} non-atomic checkpoint kills ${suffix} between passing baselines`, async () => {
      const checkId = `kernel.syscall.process-crash.${suffix}`;
      const designated = `${checkId}.pendingNode.1.resultField`;
      const baselineAdapter = `typescript/kernel/conformance-adapter/adapter-${backend}.json`;
      const before = await runCheck(baselineAdapter, checkId, 0);
      expect(before.status).toBe("pass");
      expect(before.assertionResults).toContainEqual({
        assertionId: designated,
        status: "pass",
      });
      assertFaultReceipt(before, point);

      const directory = await mkdtemp(
        path.join(tmpdir(), "tuvren-durable-control-")
      );
      try {
        const mutant = await runCheck(
          await probeManifest(backend, directory),
          checkId,
          1
        );
        expect(mutant.status).toBe("fail");
        expect(mutant.failure?.classification).toBe("implementation");
        expect(mutant.details?.experimentStatus).not.toBe("invalid");
        assertFaultReceipt(mutant, point);
        expect(
          mutant.assertionResults.filter(
            (assertion) => assertion.status === "fail"
          )
        ).toEqual([{ assertionId: designated, status: "fail" }]);
        const names = await readdir(directory);
        const records: unknown[] = await Promise.all(
          names
            .filter((name) => name !== "adapter.json")
            .map(async (name): Promise<unknown> =>
              JSON.parse(await readFile(path.join(directory, name), "utf-8"))
            )
        );
        const reached = records.filter(
          (record) => field(record, "trigger") === "faultReached"
        );
        expect(reached).toHaveLength(1);
        expect(field(reached[0], "processEpoch")).toBe(1);
        expect(
          field(
            reached[0],
            "activationBeforeArming",
            "result",
            "value",
            "result",
            "activation",
            "activationCount"
          )
        ).toBe(0);
        expect(
          field(reached[0], "reply", "result", "value", "result", "activation")
        ).toMatchObject({
          activated: true,
          activationCount: 2,
          mutantId: MUTANT,
          signal: "mutant.non-atomic-checkpoint.entered",
        });
        expect(
          records.some(
            (record) =>
              field(record, "processEpoch") === 2 &&
              field(
                record,
                "reply",
                "result",
                "value",
                "result",
                "activation",
                "activationCount"
              ) === 0
          )
        ).toBe(true);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }

      const after = await runCheck(baselineAdapter, checkId, 0);
      expect(after.status).toBe("pass");
      expect(after.assertionResults).toContainEqual({
        assertionId: designated,
        status: "pass",
      });
      assertFaultReceipt(after, point);
    }, 180_000);
  }
}

const raceId = "kernel.syscall.shared_writer.race";
const raceMutant = "kernel.accept-stale-shared-writer";
const raceAssertion = `${raceId}.collect.1.resultField`;

test("postgres stale shared writer preserves the sequential lateral-lineage rejection plan", async () => {
  const check = await runCheck(
    "typescript/kernel/conformance-adapter/adapter-postgres-mutant.json",
    "kernel.syscall.kernel-protocol-af.branch-set-head-rejects-lateral-lineage",
    0,
    raceMutant
  );
  expect(check.status).toBe("pass");
});

test("shared-writer control module loads for browser targets without node async hooks", async () => {
  const result = await build({
    entrypoints: [
      "typescript/kernel/testkit/src/lib/kernel-mutant-shared-writer.ts",
    ],
    target: "browser",
  });
  expect(result.success, result.logs.join("\n")).toBe(true);
});

test("postgres shared-writer control wraps frozen backends, preserves optional clocks, and counts only stale fallback writes", async () => {
  await withCheckStorage("postgres-database", async (storageRef) => {
    const child = spawn({
      cmd: [
        "node",
        "tools/conformance/harness/test/fixtures/shared-writer-backend-surface.mjs",
        storageRef,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    expect(stdout).toBe("");
  });
}, 30_000);

const raceTrace = (check: ConformanceCheckResult, stepId: string): unknown => {
  const observations = check.details?.traceObservations;
  if (!Array.isArray(observations)) {
    throw new Error("missing race observations");
  }
  return observations.find(
    (entry: unknown) => field(entry, "stepId") === stepId
  );
};

const assertRaceReceipts = (check: ConformanceCheckResult): void => {
  const schedule = check.details?.schedule;
  if (!Array.isArray(schedule)) {
    throw new Error("missing race schedule");
  }
  const releases = schedule.filter(
    (entry: unknown) => field(entry, "stepId") === "release"
  );
  expect(releases).toHaveLength(1);
  for (const [stepId, processName] of [
    ["firstReceipt", "primary"],
    ["secondReceipt", "second"],
  ]) {
    const receipt: unknown = schedule.find(
      (entry: unknown) => field(entry, "stepId") === stepId
    );
    expect(receipt).toMatchObject({
      process: processName,
      receipt: {
        barrierId: "writers",
        seam: "kernel.persistence.before-transact",
        operationHandle: expect.any(String),
      },
    });
    const arrival = field(receipt, "arrivalSequence");
    if (typeof arrival !== "number") {
      throw new Error("missing entry arrival");
    }
    for (const release of releases) {
      const released = field(release, "arrivalSequence");
      if (typeof released !== "number") {
        throw new Error("missing release arrival");
      }
      expect(arrival).toBeLessThan(released);
    }
  }
};

test("postgres stale shared writer commits both siblings and activates only the lateral fallback between passing baselines", async () => {
  const baseline =
    "typescript/kernel/conformance-adapter/adapter-postgres.json";
  const before = await runCheck(baseline, raceId, 0, raceMutant);
  expect(before.status).toBe("pass");
  expect(before.assertionResults).toContainEqual({
    assertionId: raceAssertion,
    status: "pass",
  });
  assertRaceReceipts(before);

  const directory = await mkdtemp(
    path.join(tmpdir(), "tuvren-shared-writer-control-")
  );
  try {
    const mutant = await runCheck(
      await probeManifest("postgres", directory),
      raceId,
      1,
      raceMutant
    );
    expect(mutant.status).toBe("fail");
    expect(mutant.failure?.classification).toBe("implementation");
    expect(mutant.details?.experimentStatus).not.toBe("invalid");
    expect(mutant.assertionResults).toContainEqual({
      assertionId: raceAssertion,
      status: "fail",
    });
    expect(mutant.assertionResults).toContainEqual({
      assertionId: `${raceId}.collect.2.resultField`,
      status: "fail",
    });
    assertRaceReceipts(mutant);
    const processes = mutant.details?.processes;
    if (!Array.isArray(processes)) {
      throw new Error("missing race processes");
    }
    expect(
      processes.map((entry: unknown) => field(entry, "name")).toSorted()
    ).toEqual(["primary", "second"]);
    expect(
      new Set(processes.map((entry: unknown) => field(entry, "pid"))).size
    ).toBe(2);
    const counts: number[] = [];
    const heads: string[] = [];
    for (const processName of ["primary", "second"]) {
      const owner: unknown = processes.find(
        (entry: unknown) => field(entry, "name") === processName
      );
      expect(owner).toMatchObject({ exit: { code: 0, signal: null } });
      const pid = field(owner, "pid");
      if (typeof pid !== "number") {
        throw new Error("missing process pid");
      }
      const record: unknown = JSON.parse(
        await readFile(path.join(directory, `${pid}.json`), "utf-8")
      );
      const activation = field(
        record,
        "reply",
        "result",
        "value",
        "result",
        "activation"
      );
      expect(activation).toMatchObject({
        mutantId: raceMutant,
      });
      const count = field(activation, "activationCount");
      if (typeof count !== "number") {
        throw new Error("missing fallback activation count");
      }
      counts.push(count);
      expect(activation).toEqual({
        activated: count > 0,
        activationCount: count,
        kind: "implementation",
        mutantId: raceMutant,
        signal: "mutant.accept-stale-shared-writer.entered",
      });
      const outcome = raceTrace(
        mutant,
        processName === "primary" ? "firstOutcome" : "secondOutcome"
      );
      expect(field(outcome, "outcome", "kind")).toBe("result");
      const head = field(
        outcome,
        "outcome",
        "value",
        "result",
        "branch",
        "headTurnNodeHash"
      );
      if (typeof head !== "string") {
        throw new Error("missing committed writer head");
      }
      heads.push(head);
      const checkpoint = raceTrace(
        mutant,
        processName === "primary" ? "aCheckpoint" : "bCheckpoint"
      );
      expect(head).toBe(
        field(checkpoint, "outcome", "value", "result", "turnNodeHash")
      );
    }
    expect(counts.toSorted()).toEqual([0, 1]);
    expect(heads[0]).not.toBe(heads[1]);
    expect(heads).toContain(
      field(
        raceTrace(mutant, "head"),
        "outcome",
        "value",
        "result",
        "headTurnNodeHash"
      )
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }

  const after = await runCheck(baseline, raceId, 0, raceMutant);
  expect(after.status).toBe("pass");
  expect(after.assertionResults).toContainEqual({
    assertionId: raceAssertion,
    status: "pass",
  });
  assertRaceReceipts(after);
}, 90_000);
