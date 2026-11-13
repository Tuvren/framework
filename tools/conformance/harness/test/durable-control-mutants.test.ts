import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  expectedExit: 0 | 1
): Promise<ConformanceCheckResult> => {
  const child = Bun.spawn({
    cmd: [
      "bun",
      "tools/conformance/harness/run.ts",
      "--adapter",
      adapter,
      "--check",
      checkId,
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
  expect(exit, stderr).toBe(expectedExit);
  const evidence: unknown = JSON.parse(stdout);
  assertConformanceEvidence(evidence, "non-atomic checkpoint control");
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
  test(`${backend} non-atomic checkpoint preserves frozen backend capabilities and optional transaction clocks`, async () => {
    await withCheckStorage(
      backend === "sqlite" ? "sqlite-directory" : "postgres-database",
      async (storageRef) => {
        const child = Bun.spawn({
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
