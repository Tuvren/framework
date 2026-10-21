/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { runCommand } from "./command-runner.js";

const isAlive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // Container PID 1 may retain an orphan zombie; it cannot execute or hold
      // descriptors. It is no longer a running descendant.
      const stat = await readFile(`/proc/${pid}/stat`, "utf-8");
      return stat.slice(stat.lastIndexOf(")") + 2, -1).split(" ")[0] !== "Z";
    }
    return true;
  } catch {
    return false;
  }
};

const expectStopped = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100 && (await isAlive(pid)); attempt += 1) {
    await sleep(10);
  }
  expect(await isAlive(pid)).toBe(false);
};

interface ScenarioExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

/**
 * Runs `body` in a child process that imports runCommand, sends it `signal`
 * once every listed pid file exists, and reports how it terminated.
 */
const runSignalScenario = async (
  root: string,
  body: string,
  signal: NodeJS.Signals,
  pidFiles: readonly string[]
): Promise<ScenarioExit & { pids: number[] }> => {
  const fixture = path.join(root, "scenario.ts");
  await writeFile(
    fixture,
    `import { runCommand } from ${JSON.stringify(new URL("./command-runner.ts", import.meta.url).href)};\n${body}`
  );
  const child = spawn(process.execPath, [fixture], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  const exited = new Promise<ScenarioExit>((resolve) => {
    child.once("close", (code, exitSignal) =>
      resolve({ code, signal: exitSignal, stdout })
    );
  });
  const pids: number[] = [];
  try {
    for (const pidFile of pidFiles) {
      let pid = Number.NaN;
      for (let attempt = 0; attempt < 500 && Number.isNaN(pid); attempt += 1) {
        try {
          pid = Number.parseInt(await readFile(pidFile, "utf-8"), 10);
        } catch {
          await sleep(10);
        }
      }
      if (Number.isNaN(pid)) {
        throw new Error("scenario descendant did not start");
      }
      pids.push(pid);
    }
    child.kill(signal);
    const result = await exited;
    return { ...result, pids };
  } finally {
    child.kill("SIGKILL");
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  }
};

const ownedSleep = (pidFile: string): string =>
  `runCommand(["sh", "-c", ${JSON.stringify(`sleep 30 & echo $! > ${pidFile}; wait`)}], { signal: new AbortController().signal, terminationGraceMs: 100 })`;

describe("runCommand signal relay", () => {
  test.each([
    ["SIGHUP", 129],
    ["SIGQUIT", 131],
  ] as const)(
    "%s stops the owned group and leaves cancellation to a caller with its own listener",
    async (signal, status) => {
      const root = await mkdtemp(path.join(tmpdir(), "relay-hup-test-"));
      try {
        const pidFile = path.join(root, "pid");
        const result = await runSignalScenario(
          root,
          `process.on(${JSON.stringify(signal)}, () => {});\nconst r = await ${ownedSleep(pidFile)};\nconsole.log("CONTINUED " + r.code);`,
          signal,
          [pidFile]
        );
        expect(result.signal).toBeNull();
        expect(result.code).toBe(status);
        expect(result.stdout).toContain(`CONTINUED ${status}`);
        const [pid] = result.pids;
        if (pid === undefined) {
          throw new Error("missing pid");
        }
        await expectStopped(pid);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  test.each([
    ["SIGINT", 130],
    ["SIGHUP", 129],
    ["SIGTERM", 143],
  ] as const)(
    "%s without a caller listener stops every owned group then terminates the caller",
    async (signal, status) => {
      const root = await mkdtemp(path.join(tmpdir(), "relay-default-test-"));
      try {
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        const result = await runSignalScenario(
          root,
          `await Promise.all([${ownedSleep(first)}, ${ownedSleep(second)}]);\nconsole.log("CONTINUED");`,
          signal,
          [first, second]
        );
        expect(result.stdout).not.toContain("CONTINUED");
        // Bun reports a re-raised default disposition as the signal itself or
        // as the conventional 128+signo status.
        expect(result.signal === signal || result.code === status).toBe(true);
        for (const pid of result.pids) {
          await expectStopped(pid);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  test("normal completion does not re-raise or leave relay listeners", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "relay-clean-test-"));
    try {
      const fixture = path.join(root, "clean.ts");
      await writeFile(
        fixture,
        `import { runCommand } from ${JSON.stringify(new URL("./command-runner.ts", import.meta.url).href)};\nawait runCommand(["true"], { timeoutMs: 5000 });\nconsole.log(["SIGHUP","SIGINT","SIGQUIT","SIGTERM"].map((s) => process.listenerCount(s)).join(","));`
      );
      const result = await runCommand([process.execPath, fixture], {
        captureOutput: true,
        timeoutMs: 5000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("0,0,0,0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runCommand", () => {
  test("rejects empty argv with the executable precondition message", async () => {
    let failure: unknown;
    try {
      await runCommand([]);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected the empty command to reject");
    }
    expect(failure.message).toBe("runCommand requires an executable");
  });

  test("merges explicit environment overrides", async () => {
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        "process.stdout.write(JSON.stringify([process.env.TEST_VALUE, process.env.PATH]))",
      ],
      {
        captureOutput: true,
        env: {
          TEST_VALUE: "interop-fast-path",
        },
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify(["interop-fast-path", process.env.PATH])
    );
  });

  test("preserves output and the exit code for a failed command", async () => {
    const result = await runCommand(
      [
        process.execPath,
        "--eval",
        "process.stdout.write('before failure'); process.stderr.write('failure detail'); process.exitCode = 7",
      ],
      { captureOutput: true }
    );

    expect(result).toEqual({
      code: 7,
      stderr: "failure detail",
      stdout: "before failure",
    });
  });

  test("returns the fallback exit code when the child dies from a signal", async () => {
    const result = await runCommand(
      [process.execPath, "--eval", "process.kill(process.pid, 'SIGTERM')"],
      { captureOutput: true }
    );

    expect(result).toEqual({ code: 1, stderr: "", stdout: "" });
  });

  test("returns a timeout exit code when the command exceeds the deadline", async () => {
    const result = await runCommand(
      [process.execPath, "--eval", "setTimeout(() => {}, 1000)"],
      {
        captureOutput: true,
        timeoutMs: 25,
      }
    );

    expect(result.code).toBe(124);
    expect(result.stderr).toContain("command timed out after 25ms");
  });

  test("times out a descendant retaining pipes after the immediate child exits", async () => {
    const started = Date.now();
    const result = await runCommand(
      ["sh", "-c", "sleep 30 & echo $!; exit 0"],
      {
        captureOutput: true,
        timeoutMs: 100,
        terminationGraceMs: 100,
      }
    );
    expect(result.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(2000);
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await expectStopped(pid);
  });

  test("escalates when a command and its descendant ignore graceful termination", async () => {
    const started = Date.now();
    const result = await runCommand(
      ["sh", "-c", "trap '' TERM; sleep 30 & echo $!; wait"],
      {
        captureOutput: true,
        timeoutMs: 100,
        terminationGraceMs: 100,
      }
    );
    expect(result.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(2000);
    await expectStopped(Number(result.stdout.trim()));
  });

  test("cancels the owned command group and removes the abort listener", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await runCommand(
        ["sh", "-c", "sleep 30 & echo $!; wait"],
        {
          captureOutput: true,
          signal: controller.signal,
          terminationGraceMs: 100,
        }
      );
      expect(result.code).toBe(130);
      expect(result.stderr).toBe("command cancelled");
      await expectStopped(Number(result.stdout.trim()));
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      const next = await runCommand(
        [process.execPath, "-e", "process.stdout.write('ok')"],
        { captureOutput: true }
      );
      expect(next.stdout).toBe("ok");
    } finally {
      clearTimeout(timer);
    }
  });

  test("does not start a command with an already aborted signal", async () => {
    const result = await runCommand(
      ["no-such-executable-should-not-be-spawned"],
      {
        signal: AbortSignal.abort(),
      }
    );
    expect(result.code).toBe(130);
  });

  test("spools both streams directly to disk without returning captured output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "command-log-test-"));
    try {
      const logFile = path.join(root, "output.log");
      const result = await runCommand(
        [
          process.execPath,
          "-e",
          "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
        ],
        { outputFile: logFile }
      );
      expect(result).toEqual({ code: 7, stdout: "", stderr: "" });
      expect(await readFile(logFile, "utf-8")).toBe("outerr");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans up timeout handles after a failed spawn", async () => {
    await expect(
      runCommand(["no-such-executable-command-runner-test"], {
        captureOutput: true,
        timeoutMs: 30,
      })
    ).rejects.toThrow();
    // An outstanding timer must not attempt to signal an unrelated process.
    await sleep(60);
  });

  test("outer cancellation stops nested timeout groups before terminating their owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nested-command-test-"));
    const pidFile = path.join(root, "nested.pid");
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const waitUntilReady = async (): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          descendantPid = Number(await readFile(pidFile, "utf-8"));
          controller.abort();
          return;
        } catch {
          await sleep(10);
        }
      }
      controller.abort();
      throw new Error("nested command did not start");
    };
    const innerSource = `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const outerSource = `import { runCommand } from ${JSON.stringify(new URL("./command-runner.ts", import.meta.url).href)}; await runCommand([process.execPath, '-e', ${JSON.stringify(innerSource)}], { captureOutput: true, timeoutMs: 30000 });`;
    try {
      const [result] = await Promise.all([
        runCommand([process.execPath, "-e", outerSource], {
          captureOutput: true,
          signal: controller.signal,
          timeoutMs: 4000,
        }),
        waitUntilReady(),
      ]);
      expect(result.code).toBe(130);
      if (descendantPid === undefined) {
        throw new Error("missing nested pid");
      }
      await expectStopped(descendantPid);
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans up a background descendant after successful leader exit without changing the exit code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "completed-command-test-"));
    const pidFile = path.join(root, "background.pid");
    const background = `import {writeFileSync} from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const leader = `import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs'; spawn(process.execPath, ['-e', ${JSON.stringify(background)}], {stdio:'ignore'}).unref(); const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); process.exit(0); } }, 10);`;
    let descendantPid: number | undefined;
    try {
      const result = await runCommand([process.execPath, "-e", leader], {
        captureOutput: true,
        timeoutMs: 4000,
        terminationGraceMs: 100,
      });
      descendantPid = Number(await readFile(pidFile, "utf-8"));
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      await expectStopped(descendantPid);
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
