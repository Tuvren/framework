/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 * Licensed under the Apache License, Version 2.0.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
      const results = await runVerificationPhases([{ id: 'cancel', concurrency: 1, mutatesWorktree: true, steps: [
        { id: 'running', command: [process.execPath, '-e', ${JSON.stringify(childSource)}] },
        { id: 'queued', command: [process.execPath, '-e', "process.stdout.write('UNEXPECTED')"] }
      ] }], { logDirectory: ${JSON.stringify(logs)} });
      clearInterval(timer);
      if (hasVerificationFailure(results)) process.exitCode ??= 1;
    `,
      root
    );
    descendantPid = Number(await readFile(pidFile, "utf-8"));
    expect(result.code).toBe(143);
    expect(result.stdout).not.toContain("UNEXPECTED");
    expect(result.stdout).toContain("command cancelled");
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
