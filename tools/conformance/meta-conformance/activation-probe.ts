#!/usr/bin/env bun
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

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import nodePath from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

/**
 * Transparent stdio relay between the shared harness and a mutant adapter.
 * Before the harness's shutdown request reaches the adapter (or when the
 * harness closes stdin), it dispatches the mutant activation control
 * operation and records the raw reply, or the adapter's exit, as
 * `<record>/<pid>.json`. Every other frame passes through unchanged.
 */

const ACTIVATION_PROBE_ID = "tuvren-negative-control-activation-probe";
const PROBE_TIMEOUT_MS = 10_000;

const readArgs = (
  args: readonly string[]
): { command: string[]; operation: string; record: string } => {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator === -1 ? args.length : separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const value = (flag: string): string => {
    const found = options[options.indexOf(flag) + 1];
    if (!options.includes(flag) || found === undefined) {
      throw new Error(`activation probe requires ${flag}`);
    }
    return found;
  };
  if (command.length === 0) {
    throw new Error("activation probe requires -- <adapter command>");
  }
  return {
    command,
    operation: value("--operation"),
    record: value("--record"),
  };
};

const readFrame = (line: string): Record<string, unknown> | undefined => {
  try {
    const frame: unknown = JSON.parse(line);
    return typeof frame === "object" && frame !== null && !Array.isArray(frame)
      ? Object.fromEntries(Object.entries(frame))
      : undefined;
  } catch {
    return undefined;
  }
};

const options = readArgs(process.argv.slice(2));
const [executable, ...executableArgs] = options.command;
const child = spawn(executable ?? "", executableArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});
let recorded = false;
let exited = false;
let resolveProbe: ((frame: unknown) => void) | undefined;

const record = (entry: Record<string, unknown>): void => {
  if (recorded) {
    return;
  }
  recorded = true;
  writeFileSync(
    nodePath.join(options.record, `${process.pid}.json`),
    `${JSON.stringify(entry)}\n`
  );
};

const probe = async (): Promise<void> => {
  if (recorded || exited || !child.stdin.writable) {
    return;
  }
  const reply = Promise.withResolvers<unknown>();
  resolveProbe = reply.resolve;
  const timer = setTimeout(() => {
    reply.resolve(null);
  }, PROBE_TIMEOUT_MS);
  child.stdin.write(
    `${JSON.stringify({
      id: ACTIVATION_PROBE_ID,
      jsonrpc: "2.0",
      method: "dispatch",
      params: { controls: {}, input: {}, operation: options.operation },
    })}\n`
  );
  const frame = await reply.promise;
  clearTimeout(timer);
  resolveProbe = undefined;
  record(
    frame === null
      ? {
          error: `no reply to ${options.operation} within ${PROBE_TIMEOUT_MS}ms`,
        }
      : { reply: frame }
  );
};

createInterface({ input: child.stdout }).on("line", (line) => {
  const frame = readFrame(line);
  if (frame?.id === ACTIVATION_PROBE_ID && resolveProbe !== undefined) {
    resolveProbe(frame);
    return;
  }
  process.stdout.write(`${line}\n`);
});

child.stdin.on("error", (error) => {
  record({ error: `adapter stdin closed: ${error.message}` });
});
child.on("exit", (code, signal) => {
  exited = true;
  resolveProbe?.(null);
  record({ exit: { code, signal } });
});
child.on("close", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  record({ error: `adapter failed to start: ${error.message}` });
  process.exit(1);
});
process.on("SIGTERM", () => {
  record({ error: "terminated before the activation probe" });
  child.kill("SIGTERM");
  process.exit(143);
});

for await (const line of createInterface({ input: process.stdin })) {
  if (readFrame(line)?.method === "shutdown") {
    await probe();
  }
  if (!exited) {
    child.stdin.write(`${line}\n`);
  }
}
await probe();
child.stdin.end();
