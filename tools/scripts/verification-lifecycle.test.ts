/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 * Licensed under the Apache License, Version 2.0.
 */

import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { runCommand } from "./lib/command-runner.js";

const scratch: string[] = [];
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(
    path.join(tmpdir(), "verification-lifecycle-test-")
  );
  scratch.push(root);
  return root;
};

afterEach(async () => {
  for (const root of scratch.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

const runFixture = async (
  source: string,
  root: string
): Promise<Awaited<ReturnType<typeof runCommand>>> => {
  const fixture = path.join(root, "scenario.ts");
  await writeFile(
    fixture,
    `import { runVerificationPhases, hasVerificationFailure } from ${JSON.stringify(new URL("./verify.ts", import.meta.url).href)};\n${source}`
  );
  return await runCommand([process.execPath, fixture], {
    captureOutput: true,
    timeoutMs: 5000,
  });
};

test("parallel steps replay complete disk logs in plan order and remove successful logs", async () => {
  const root = await createRoot();
  const logs = path.join(root, "logs");
  const steps = [
    {
      id: "first-step",
      command: [
        process.execPath,
        "-e",
        "setTimeout(() => process.stdout.write('FIRST-OUTPUT'), 80)",
      ],
    },
    {
      id: "second-step",
      command: [
        process.execPath,
        "-e",
        "process.stderr.write('SECOND-OUTPUT')",
      ],
    },
  ];
  const result = await runFixture(
    `
    const results = await runVerificationPhases([{id: 'parallel', mutatesWorktree: true, steps: ${JSON.stringify(steps)}}], { logDirectory: ${JSON.stringify(logs)} });
    console.log(JSON.stringify(results));
    if (hasVerificationFailure(results)) process.exitCode ??= 1;
  `,
    root
  );
  expect(result.code).toBe(0);
  // Headers include the argv; the final occurrences are the actual replay.
  expect(result.stdout.lastIndexOf("FIRST-OUTPUT")).toBeLessThan(
    result.stdout.lastIndexOf("SECOND-OUTPUT")
  );
  expect(await readdir(logs)).toEqual([]);
});

test("a failed command retains its complete log and prevents the next serial step", async () => {
  const root = await createRoot();
  const logs = path.join(root, "logs");
  const result = await runFixture(
    `
    const results = await runVerificationPhases([{ id: 'serial', concurrency: 1, mutatesWorktree: true, steps: [
      { id: 'failure', command: [process.execPath, '-e', "process.stderr.write('FAILURE-DETAIL'); process.exitCode = 7"] },
      { id: 'never-started', command: [process.execPath, '-e', "process.stdout.write('UNEXPECTED')"] }
    ] }], { logDirectory: ${JSON.stringify(logs)} });
    if (hasVerificationFailure(results)) process.exitCode ??= 1;
  `,
    root
  );
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain("UNEXPECTED");
  const [run] = await readdir(logs);
  if (run === undefined) {
    throw new Error("missing failure log directory");
  }
  expect(await readFile(path.join(logs, run, "0.log"), "utf-8")).toContain(
    "FAILURE-DETAIL"
  );
  expect(result.stderr).toContain(path.join(logs, run));
});

test("SIGTERM cancels descendants, preserves its exit status, and stops queued steps", async () => {
  const root = await createRoot();
  const pidFile = path.join(root, "pid");
  const logs = path.join(root, "logs");
  const childSource = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child = spawn('sleep', ['30'], {stdio:'inherit'}); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(()=>{},1000);`;
  let descendantPid: number | undefined;
  try {
    const result = await runFixture(
      `
      import {existsSync} from 'node:fs';
      const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); process.kill(process.pid, 'SIGTERM'); } }, 10);
      const results = await runVerificationPhases([{ id: 'cancel', concurrency: 2, mutatesWorktree: true, steps: [
        { id: 'running', command: [process.execPath, '-e', ${JSON.stringify(childSource)}] },
        { id: 'running-too', command: [process.execPath, '-e', ${JSON.stringify(childSource)}] },
        { id: 'queued', command: [process.execPath, '-e', "process.stdout.write('UNEXPECTED')"] }
      ] }], { logDirectory: ${JSON.stringify(logs)} });
      clearInterval(timer);
      console.log("STEP-CODES " + JSON.stringify(results.map((r) => [r.id, r.code])));
      if (hasVerificationFailure(results)) process.exitCode ??= 1;
    `,
      root
    );
    descendantPid = Number(await readFile(pidFile, "utf-8"));
    expect(result.code).toBe(143);
    expect(result.stdout).not.toContain("UNEXPECTED");
    expect(result.stdout).toContain("command cancelled");
    expect(result.stdout).toContain(
      'STEP-CODES [["running",143],["running-too",143],["queued",143]]'
    );
    const state = await runCommand(
      ["ps", "-o", "stat=", "-p", String(descendantPid)],
      { captureOutput: true }
    );
    expect(
      state.stdout.trim() === "" || state.stdout.trim().startsWith("Z")
    ).toBe(true);
    expect(await readdir(logs)).toHaveLength(1);
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  }
});

test("a repeated signal abandons a stalled replay and keeps the signal status and log location", async () => {
  const root = await createRoot();
  const pidFile = path.join(root, "pid");
  const logs = path.join(root, "logs");
  const childSource = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('STEP-OUTPUT'); setInterval(()=>{},1000);`;
  const result = await runFixture(
    `
    import {existsSync} from 'node:fs';
    // A consumer that never drains: replay can only end by abortion.
    process.stdout.write = () => true;
    const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); process.kill(process.pid, 'SIGTERM'); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300); } }, 10);
    const results = await runVerificationPhases([{ id: 'cancel', concurrency: 1, mutatesWorktree: true, steps: [
      { id: 'running', command: [process.execPath, '-e', ${JSON.stringify(childSource)}] }
    ] }], { logDirectory: ${JSON.stringify(logs)} });
    clearInterval(timer);
    if (hasVerificationFailure(results)) process.exitCode ??= 1;
  `,
    root
  );
  expect(result.code).toBe(143);
  expect(result.stderr).toContain("Verification logs retained");
  expect(await readdir(logs)).toHaveLength(1);
});

interface PipeScenario {
  code: number | null;
  elapsedMs: number;
  stderr: string;
  stdoutBytes: number;
}

/**
 * Runs a verification scenario in a child whose stdout is a real OS pipe and
 * delivers `signals` once the step has started. `consume` decides how the
 * parent treats the read end of that pipe.
 */
const runPipeScenario = async (
  root: string,
  steps: readonly object[],
  signals: readonly NodeJS.Signals[],
  consume: "never-read" | "close"
): Promise<PipeScenario> => {
  const logs = path.join(root, "logs");
  const pidFile = path.join(root, "pid");
  const fixture = path.join(root, "pipe-scenario.ts");
  await writeFile(
    fixture,
    `import { runVerificationMain } from ${JSON.stringify(new URL("./verify.ts", import.meta.url).href)};\nawait runVerificationMain([{ id: 'cancel', concurrency: 1, mutatesWorktree: true, steps: ${JSON.stringify(steps)} }], { logDirectory: ${JSON.stringify(logs)} });\n`
  );
  const child = spawn(process.execPath, [fixture], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  let stdoutBytes = 0;
  if (consume === "never-read") {
    child.stdout.pause();
  } else {
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
    });
  }
  const started = Date.now();
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  try {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (
        await access(pidFile).then(
          () => true,
          () => false
        )
      ) {
        break;
      }
      await sleep(10);
    }
    // Let the step's output reach the log before cancelling.
    await sleep(300);
    if (consume === "close") {
      child.stdout.destroy();
    }
    for (const [index, signal] of signals.entries()) {
      if (index > 0) {
        await sleep(300);
      }
      child.kill(signal);
    }
    const code = await Promise.race([
      exited,
      sleep(15_000).then(() => "timeout" as const),
    ]);
    if (code === "timeout") {
      throw new Error(`child did not exit promptly; stderr: ${stderr}`);
    }
    return { code, elapsedMs: Date.now() - started, stderr, stdoutBytes };
  } finally {
    child.kill("SIGKILL");
  }
};

const bulkStep = (root: string): object => ({
  id: "bulk",
  command: [
    process.execPath,
    "-e",
    `import {writeFileSync} from 'node:fs'; process.stdout.write('x'.repeat(8 * 1024 * 1024)); writeFileSync(${JSON.stringify(path.join(root, "pid"))}, String(process.pid)); setInterval(()=>{},1000);`,
  ],
});

test("a repeated signal exits promptly despite pending writes to an unread stdout pipe", async () => {
  const root = await createRoot();
  const result = await runPipeScenario(
    root,
    [bulkStep(root)],
    ["SIGTERM", "SIGTERM"],
    "never-read"
  );
  expect(result.code).toBe(143);
  expect(result.stderr).toContain("Verification logs retained");
  const [run] = await readdir(path.join(root, "logs"));
  if (run === undefined) {
    throw new Error("missing retained log directory");
  }
  const owner = JSON.parse(
    await readFile(path.join(root, "logs", run, "owner.json"), "utf-8")
  ) as { finishedAt?: number };
  expect(typeof owner.finishedAt).toBe("number");
});

test.each([
  ["SIGHUP", 129],
  ["SIGTERM", 143],
] as const)(
  "%s keeps its status when the stdout consumer has gone away",
  async (signal, status) => {
    const root = await createRoot();
    const result = await runPipeScenario(
      root,
      [bulkStep(root)],
      [signal],
      "close"
    );
    expect(result.code).toBe(status);
    expect(result.stderr).not.toContain("EPIPE");
    expect(result.stderr).toContain("Verification logs retained");
    expect(await readdir(path.join(root, "logs"))).toHaveLength(1);
  }
);
