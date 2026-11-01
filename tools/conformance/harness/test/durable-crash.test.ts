import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { spawn } from "bun";

import { assertConformanceEvidence } from "../../../scripts/lib/conformance-contract.ts";

const points = [
  ["before-commit", "before_commit"],
  ["after-turn-node-write-before-head", "after_turn_node_write_before_head"],
  [
    "after-head-move-before-staging-clear",
    "after_head_move_before_staging_clear",
  ],
  ["after-commit-before-ack", "after_commit_before_ack"],
] as const;

for (const backend of ["sqlite", "postgres"]) {
  for (const [point, suffix] of points) {
    test(`${backend} crash at ${point} is activated by a receipt and same-epoch SIGKILL, then recovers`, async () => {
      const process = spawn({
        cmd: [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          `typescript/kernel/conformance-adapter/adapter-${backend}.json`,
          "--check",
          `kernel.syscall.process-crash.${suffix}`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit, stderr).toBe(0);
      const evidence: unknown = JSON.parse(stdout);
      assertConformanceEvidence(evidence, "durable process-crash evidence");
      expect(evidence.checkResults).toHaveLength(1);
      const check = evidence.checkResults[0];
      expect(check?.status).toBe("pass");
      const observedAssertion =
        suffix === "after_commit_before_ack"
          ? ".recoveredHead.1.resultField"
          : ".pendingNode.1.resultField";
      expect(
        check?.assertionResults.some(
          (entry) =>
            entry.assertionId.endsWith(observedAssertion) &&
            entry.status === "pass"
        )
      ).toBe(true);
      const detail = check?.details;
      expect(detail?.fault).toMatchObject({
        armed: [{ mode: "block", point }],
        receipts: [{ phase: point, processEpoch: 1 }],
      });
      const fault = detail?.fault as {
        armed: { token: string }[];
        receipts: { token: string; processEpoch: number }[];
        activations: string[];
      };
      expect(fault.receipts[0]?.token).toBe(fault.armed[0]?.token);
      expect(fault.activations).toContain(fault.armed[0]?.token);
      expect(detail?.process).toMatchObject({
        epochs: [
          {
            epoch: 1,
            signal: "SIGKILL",
            exit: { code: null, signal: "SIGKILL" },
          },
          { epoch: 2 },
        ],
      });
      expect(
        check?.assertionResults.some(
          (assertion) =>
            assertion.assertionId.includes("processExit") &&
            assertion.status === "pass"
        )
      ).toBe(true);
      expect(
        check?.assertionResults.some(
          (assertion) =>
            assertion.assertionId.includes(".kill.2.processExit") &&
            assertion.status === "pass"
        )
      ).toBe(true);
      expect(
        check?.assertionResults.some(
          (assertion) =>
            assertion.assertionId.includes(".kill.1.faultActivated") &&
            assertion.status === "pass"
        )
      ).toBe(true);
      expect(
        check?.assertionResults.some(
          (assertion) =>
            assertion.assertionId.includes("faultActivated") &&
            assertion.status === "pass"
        )
      ).toBe(true);
    }, 90_000);
  }

  test(`${backend} incomplete checkpoint mutant fails the designated post-commit assertions`, async () => {
    const child = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
        "--check",
        "kernel.syscall.process-crash.after_commit_before_ack",
      ],
      env: {
        ...process.env,
        TUVREN_KERNEL_MUTANT: "kernel.expose-incomplete-checkpoint",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(1);
    const evidence: unknown = JSON.parse(stdout);
    assertConformanceEvidence(evidence, "incomplete checkpoint mutant");
    const check = evidence.checkResults[0];
    expect(check?.failure?.classification).toBe("implementation");
    expect(
      check?.assertionResults.some(
        (assertion) =>
          assertion.assertionId ===
            "kernel.syscall.process-crash.after_commit_before_ack.11.resultField" &&
          assertion.status === "fail"
      )
    ).toBe(true);
  }, 90_000);

  test(`${backend} records mutant activation before the faulted epoch dies`, async () => {
    await mkdir(path.resolve(".cache"), { recursive: true });
    const directory = await mkdtemp(path.resolve(".cache/df004-probe-"));
    try {
      const manifest = JSON.parse(
        await readFile(
          `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
          "utf8"
        )
      );
      const executable = manifest.executable;
      const wrapped = {
        ...manifest,
        executable: process.execPath,
        command: [
          process.execPath,
          "tools/conformance/meta-conformance/activation-probe.ts",
          "--record",
          directory,
          "--operation",
          "kernel.mutant.activation",
          "--",
          executable,
          ...manifest.command.slice(1),
        ],
      };
      const manifestPath = path.join(directory, "adapter.json");
      await writeFile(manifestPath, JSON.stringify(wrapped));
      const child = spawn({
        cmd: [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          manifestPath,
          "--check",
          "kernel.syscall.process-crash.after_commit_before_ack",
        ],
        env: {
          ...process.env,
          TUVREN_KERNEL_MUTANT: "kernel.expose-incomplete-checkpoint",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr).toBe(1);
      const evidence: unknown = JSON.parse(stdout);
      assertConformanceEvidence(evidence, "mutant activation evidence");
      expect(
        evidence.checkResults[0]?.assertionResults.some(
          (a) =>
            a.assertionId.endsWith(".11.resultField") && a.status === "fail"
        )
      ).toBe(true);
      const records = await Promise.all(
        (await readdir(directory))
          .filter((name) => name !== "adapter.json")
          .map(async (name) =>
            JSON.parse(await readFile(path.join(directory, name), "utf8"))
          )
      );
      expect(
        records.some(
          (record) =>
            record.trigger === "faultReached" &&
            record.processEpoch === 1 &&
            record.reply?.result?.value?.result?.activation?.activated ===
              true &&
            record.reply.result.value.result.activation.signal ===
              "mutant.expose-incomplete-checkpoint.entered"
        )
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  test(`${backend} before-commit crash rolls back the incomplete-checkpoint mutation`, async () => {
    await mkdir(path.resolve(".cache"), { recursive: true });
    const directory = await mkdtemp(
      path.resolve(".cache/df-m4-before-commit-")
    );
    try {
      const manifest = JSON.parse(
        await readFile(
          `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
          "utf8"
        )
      );
      const executable = manifest.executable;
      const wrapped = {
        ...manifest,
        executable: process.execPath,
        command: [
          process.execPath,
          "tools/conformance/meta-conformance/activation-probe.ts",
          "--record",
          directory,
          "--operation",
          "kernel.mutant.activation",
          "--",
          executable,
          ...manifest.command.slice(1),
        ],
      };
      const manifestPath = path.join(directory, "adapter.json");
      await writeFile(manifestPath, JSON.stringify(wrapped));
      const child = spawn({
        cmd: [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          manifestPath,
          "--check",
          "kernel.syscall.process-crash.before_commit",
        ],
        env: {
          ...process.env,
          TUVREN_KERNEL_MUTANT: "kernel.expose-incomplete-checkpoint",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      const evidence: unknown = JSON.parse(stdout);
      assertConformanceEvidence(evidence, "before-commit mutant observation");
      expect(evidence.checkResults[0]?.status).toBe("pass");
      const records = await Promise.all(
        (await readdir(directory))
          .filter((name) => name !== "adapter.json")
          .map(async (name) =>
            JSON.parse(await readFile(path.join(directory, name), "utf8"))
          )
      );
      const reached = records.find(
        (record) =>
          record.trigger === "faultReached" && record.processEpoch === 1
      );
      const beforeArming =
        reached?.activationBeforeArming?.result?.value?.result?.activation;
      const atCrash = reached?.reply?.result?.value?.result?.activation;
      expect(beforeArming?.activationCount).toBeGreaterThan(0);
      expect(
        atCrash?.activationCount - beforeArming?.activationCount,
        JSON.stringify(reached)
      ).toBe(1);
      expect(atCrash).toMatchObject({
        mutantId: "kernel.expose-incomplete-checkpoint",
        activated: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  test(`${backend} reopen detects an activated dropped uncommitted result`, async () => {
    await mkdir(path.resolve(".cache"), { recursive: true });
    const directory = await mkdtemp(path.resolve(".cache/df004-reopen-probe-"));
    try {
      const manifest = JSON.parse(
        await readFile(
          `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
          "utf8"
        )
      );
      const manifestPath = path.join(directory, "adapter.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          executable: process.execPath,
          command: [
            process.execPath,
            "tools/conformance/meta-conformance/activation-probe.ts",
            "--record",
            directory,
            "--operation",
            "kernel.mutant.activation",
            "--",
            manifest.executable,
            ...manifest.command.slice(1),
          ],
        })
      );
      const child = spawn({
        cmd: [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          manifestPath,
          "--check",
          "kernel.syscall.reopen.close_reopen_checkpoint",
        ],
        env: {
          ...process.env,
          TUVREN_KERNEL_MUTANT:
            "kernel.drop-uncommitted-staged-result-on-recovery",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr).toBe(1);
      const evidence: unknown = JSON.parse(stdout);
      assertConformanceEvidence(evidence, "reopen mutant");
      const check = evidence.checkResults[0];
      expect(check?.failure?.classification).toBe("implementation");
      for (const suffix of [".10.resultField", ".17.resultField"]) {
        expect(
          check?.assertionResults.some(
            (a) => a.assertionId.endsWith(suffix) && a.status === "fail"
          )
        ).toBe(true);
      }
      const records = await Promise.all(
        (await readdir(directory))
          .filter((name) => name !== "adapter.json")
          .map(async (name) =>
            JSON.parse(await readFile(path.join(directory, name), "utf8"))
          )
      );
      expect(
        records.some(
          (record) =>
            record.reply?.result?.value?.result?.activation?.activated ===
              true &&
            record.reply.result.value.result.activation.signal ===
              "mutant.drop-uncommitted-staged-result-on-recovery.entered"
        )
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
}

test.each(["missing", "early"])(
  "a %s fault receipt invalidates a crash run instead of passing",
  async (mode) => {
    await mkdir(path.resolve(".cache"), { recursive: true });
    const directory = await mkdtemp(path.resolve(".cache/df004-withheld-"));
    try {
      const manifest = JSON.parse(
        await readFile(
          "typescript/kernel/conformance-adapter/adapter-sqlite.json",
          "utf8"
        )
      );
      const manifestPath = path.join(directory, "adapter.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          executable: process.execPath,
          command: [
            process.execPath,
            "tools/conformance/harness/test/fixtures/drop-fault-receipt.mjs",
            mode,
            manifest.executable,
            ...manifest.command.slice(1),
          ],
        })
      );
      const child = spawn({
        cmd: [
          "bun",
          "tools/conformance/harness/run.ts",
          "--adapter",
          manifestPath,
          "--check",
          "kernel.syscall.process-crash.before_commit",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr).toBe(1);
      const evidence: unknown = JSON.parse(stdout);
      assertConformanceEvidence(evidence, "withheld receipt");
      expect(evidence.checkResults[0]).toMatchObject({
        status: "fail",
        details: {
          experimentStatus: "invalid",
          rejection: { code: "missing_fault_activation" },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000
);

test("a receipt followed by a completed operation invalidates the crash run", async () => {
  await mkdir(path.resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(path.resolve(".cache/df004-settled-"));
  try {
    const manifest = JSON.parse(
      await readFile(
        "typescript/kernel/conformance-adapter/adapter-sqlite.json",
        "utf8"
      )
    );
    const manifestPath = path.join(directory, "adapter.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        executable: process.execPath,
        command: [
          process.execPath,
          "tools/conformance/harness/test/fixtures/settled-fault-receipt.mjs",
          manifest.executable,
          ...manifest.command.slice(1),
        ],
      })
    );
    const child = spawn({
      cmd: [
        "bun",
        "tools/conformance/harness/run.ts",
        "--adapter",
        manifestPath,
        "--check",
        "kernel.syscall.process-crash.before_commit",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(1);
    const evidence: unknown = JSON.parse(stdout);
    assertConformanceEvidence(evidence, "settled fault seam");
    expect(evidence.checkResults[0]).toMatchObject({
      status: "fail",
      details: {
        experimentStatus: "invalid",
        rejection: { code: "seam_did_not_hold" },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
