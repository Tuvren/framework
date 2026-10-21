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

import { spawn, type StdioOptions } from "node:child_process";
import { open } from "node:fs/promises";

export interface RunCommandOptions {
  captureOutput?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Spool stdout and stderr to disk instead of retaining them in memory. */
  outputFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  terminationGraceMs?: number;
}

export interface RunCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

const SHUTDOWN_BUDGET_ENV = "TUVREN_COMMAND_SHUTDOWN_GRACE_MS";
/** Termination signals that cancel work, with their 128+signo exit statuses. */
const CANCELLATION_SIGNAL_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
} as const;
export type CancellationSignal = keyof typeof CANCELLATION_SIGNAL_CODES;
export const CANCELLATION_SIGNALS = Object.keys(
  CANCELLATION_SIGNAL_CODES
) as CancellationSignal[];
export const cancellationExitCode = (signal: CancellationSignal): number =>
  CANCELLATION_SIGNAL_CODES[signal];
const isCancellationSignal = (value: unknown): value is CancellationSignal =>
  typeof value === "string" && Object.hasOwn(CANCELLATION_SIGNAL_CODES, value);
/** An abort reason naming a cancellation signal keeps that signal's status. */
const abortExitCode = (signal: AbortSignal): number =>
  isCancellationSignal(signal.reason)
    ? cancellationExitCode(signal.reason)
    : 130;

const activeCommands = new Set<(signal: CancellationSignal) => void>();
// Set when a signal arrived with no caller-owned listener; the default
// disposition is restored once every relayed command has stopped.
let pendingReraise: CancellationSignal | undefined;
const relayHandlers = new Map<CancellationSignal, () => void>();
const relaySignal = (signal: CancellationSignal): void => {
  process.exitCode = cancellationExitCode(signal);
  // The relay is prepended so it runs before any caller listener, including
  // once-listeners that remove themselves when invoked. It is the only
  // listener when the caller did not install its own cancellation handling.
  if (process.listenerCount(signal) === 1) {
    pendingReraise ??= signal;
  }
  for (const stop of [...activeCommands]) {
    stop(signal);
  }
};
for (const signal of CANCELLATION_SIGNALS) {
  relayHandlers.set(signal, () => relaySignal(signal));
}

const registerTerminationRelay = (
  stop: (signal: CancellationSignal) => void
): (() => void) => {
  if (activeCommands.size === 0) {
    for (const [signal, handler] of relayHandlers) {
      process.prependListener(signal, handler);
    }
  }
  activeCommands.add(stop);
  return () => {
    if (!activeCommands.delete(stop) || activeCommands.size > 0) {
      return;
    }
    for (const [signal, handler] of relayHandlers) {
      process.removeListener(signal, handler);
    }
    const signal = pendingReraise;
    pendingReraise = undefined;
    if (signal !== undefined) {
      process.kill(process.pid, signal);
    }
  };
};

export const runCommand = async (
  command: readonly string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> => {
  const [executable, ...args] = command;

  if (executable === undefined) {
    throw new Error("runCommand requires an executable");
  }

  if (options.captureOutput === true && options.outputFile !== undefined) {
    throw new Error(
      "runCommand cannot capture output and spool to a file together"
    );
  }
  if (options.signal?.aborted === true) {
    return {
      code: abortExitCode(options.signal),
      stderr: "command cancelled",
      stdout: "",
    };
  }

  const log =
    options.outputFile === undefined
      ? undefined
      : await open(options.outputFile, "a", 0o600);
  try {
    const { promise, resolve, reject } =
      Promise.withResolvers<RunCommandResult>();
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    // Parsing commands inherit an outer command's group. Commands with a
    // deadline or cancellation token own a group that includes descendants.
    const ownsGroup =
      process.platform !== "win32" &&
      (options.timeoutMs !== undefined || options.signal !== undefined);
    const inheritedBudget = Number(process.env[SHUTDOWN_BUDGET_ENV]);
    const requestedGrace = options.terminationGraceMs ?? 1000;
    const graceMs =
      Number.isSafeInteger(inheritedBudget) && inheritedBudget > 0
        ? Math.min(requestedGrace, inheritedBudget)
        : requestedGrace;
    let stdio: StdioOptions = "inherit";
    if (log !== undefined) {
      stdio = ["ignore", log.fd, log.fd];
    } else if (options.captureOutput === true) {
      stdio = ["ignore", "pipe", "pipe"];
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: ownsGroup,
      env: {
        ...process.env,
        ...options.env,
        // Nested managed commands relay termination to their own groups and
        // must escalate before their outer owner exhausts its grace period.
        [SHUTDOWN_BUDGET_ENV]: String(Math.max(1, Math.floor(graceMs / 2))),
      },
      stdio,
    });
    let stopCode: number | undefined;
    let stopMessage = "";
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let escalationHandle: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let escalated = false;
    let failure: Error | undefined;

    const signalOwnedCommand = (signal: NodeJS.Signals | 0): boolean => {
      if (child.pid === undefined) {
        return false;
      }
      try {
        if (ownsGroup) {
          process.kill(-child.pid, signal);
          return true;
        }
        return (
          child.exitCode === null &&
          child.signalCode === null &&
          child.kill(signal)
        );
      } catch (error: unknown) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        return false;
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeoutHandle);
      clearTimeout(escalationHandle);
      options.signal?.removeEventListener("abort", onAbort);
      unregisterRelay();
    };
    const finish = (): void => {
      if (!closed) {
        return;
      }
      // A descendant can close its pipes yet ignore TERM. Retain ownership
      // until escalation, even after the immediate child emits close.
      if (stopCode !== undefined && !escalated && signalOwnedCommand(0)) {
        return;
      }
      cleanup();
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({
        code: stopCode ?? child.exitCode ?? 1,
        stderr: [stderr, stopMessage]
          .filter((value) => value.length > 0)
          .join("\n"),
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
      });
    };
    const stop = (code: number, message: string): void => {
      if (stopCode !== undefined) {
        return;
      }
      stopCode = code;
      stopMessage = message;
      signalOwnedCommand("SIGTERM");
      escalationHandle = setTimeout(() => {
        escalated = true;
        signalOwnedCommand("SIGKILL");
        // Don't let a descendant that escaped the group retain captured pipes.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, graceMs);
      finish();
    };
    const onAbort = (): void => {
      if (options.signal !== undefined) {
        stop(abortExitCode(options.signal), "command cancelled");
      }
    };
    const unregisterRelay = ownsGroup
      ? registerTerminationRelay((signal) =>
          stop(cancellationExitCode(signal), "command cancelled")
        )
      : () => {
          /* This command inherits its caller's process group. */
        };

    if (options.captureOutput === true) {
      child.stdout?.on("data", (chunk: Uint8Array) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Uint8Array) => stderrChunks.push(chunk));
    }
    child.once("error", (error) => {
      failure = error;
      closed = true;
      cleanup();
      reject(error);
    });
    child.once("close", () => {
      closed = true;
      if (stopCode === undefined && ownsGroup && signalOwnedCommand(0)) {
        // A successful command still owns background children that closed
        // their output descriptors. Don't leave them running after completion.
        stop(child.exitCode ?? 1, "");
      }
      finish();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Opening a log file yields before listeners are installed.
    if (options.signal?.aborted) {
      onAbort();
    }
    if (options.timeoutMs !== undefined && stopCode === undefined) {
      timeoutHandle = setTimeout(() => {
        stop(124, `command timed out after ${String(options.timeoutMs)}ms`);
      }, options.timeoutMs);
    }
    return await promise;
  } finally {
    await log?.close();
  }
};
