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
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { runCommand } from "./lib/command-runner.js";

interface ReplHostInteropModule {
  DEFAULT_REPL_SCENARIOS: readonly string[];
  runReplScenarioMatrix: (input: {
    config: {
      backend: "memory";
      kernelGrpcBaseUrl: string;
      kernelMode: "rust-grpc";
      modelId?: string;
      providerMode: "fixture";
      sqlitePath?: string;
    };
    scenarios: readonly string[];
  }) => Promise<unknown>;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REPL_HOST_DIST_PATH = path.resolve(
  REPO_ROOT,
  "typescript/host/repl/dist/index.js"
);
const REPL_HOST_CLI_PATH = path.resolve(
  REPO_ROOT,
  "typescript/host/repl/dist/cli.js"
);
const WAIT_TIMEOUT_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReplHostInteropModule = (
  value: unknown
): value is ReplHostInteropModule =>
  isRecord(value) &&
  Array.isArray(value.DEFAULT_REPL_SCENARIOS) &&
  value.DEFAULT_REPL_SCENARIOS.every((entry) => typeof entry === "string") &&
  typeof value.runReplScenarioMatrix === "function";

const loadReplHostModule = async (): Promise<ReplHostInteropModule> => {
  const moduleUrl = pathToFileURL(REPL_HOST_DIST_PATH).href;
  const loaded: unknown = await import(moduleUrl);
  if (!isReplHostInteropModule(loaded)) {
    throw new TypeError("repl host module does not expose the expected API");
  }
  return loaded;
};

const spawnRustKernelService = (address: string): ChildProcess => {
  const child = spawn(
    "cargo",
    ["run", "--quiet", "-p", "tuvren-kernel-rust-grpc-service"],
    {
      cwd: REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
        TUVREN_KERNEL_GRPC_ADDR: address,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  child.unref();
  return child;
};

const runRequiredCommand = async (
  command: readonly string[],
  options?: { cwd?: string }
): Promise<void> => {
  const result = await runCommand(command, {
    cwd: options?.cwd ?? REPO_ROOT,
  });

  if (result.code !== 0) {
    throw new Error(`command failed: ${command.join(" ")}`);
  }
};

const runCliWithInput = async (
  command: readonly string[],
  stdin: string
): Promise<{ code: number; stderr: string; stdout: string }> => {
  const [executable, ...args] = command;

  if (executable === undefined) {
    throw new Error("runCliWithInput requires an executable");
  }

  const { promise, reject, resolve } = Promise.withResolvers<{
    code: number;
    stderr: string;
    stdout: string;
  }>();
  const child = spawn(executable, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "pipe",
  });
  const stderrChunks: Uint8Array[] = [];
  const stdoutChunks: Uint8Array[] = [];

  child.stderr?.on("data", (chunk: Uint8Array) => {
    stderrChunks.push(chunk);
  });
  child.stdout?.on("data", (chunk: Uint8Array) => {
    stdoutChunks.push(chunk);
  });
  child.stdin.end(stdin);
  child.once("error", reject);
  child.once("close", (code) => {
    resolve({
      code: code ?? 1,
      stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
    });
  });

  return await promise;
};

const parseJsonlRecords = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

const reservePort = async (): Promise<number> => {
  const { promise, reject, resolve } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("failed to reserve an IPv4 TCP port"));
      return;
    }

    const { port } = address;
    server.once("close", () => {
      resolve(port);
    });
    server.close();
  });
  server.once("error", reject);

  return await promise;
};

const canConnect = async (address: string): Promise<boolean> => {
  const [host, portText] = address.split(":");

  if (host === undefined || portText === undefined) {
    return false;
  }

  const port = Number(portText);

  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.createConnection({ host, port });
  const finish = (value: boolean) => {
    socket.destroy();
    resolve(value);
  };

  socket.once("connect", () => {
    finish(true);
  });
  socket.once("error", () => {
    finish(false);
  });

  return await promise;
};

const readStream = async (
  stream: NodeJS.ReadableStream | null
): Promise<string> => {
  if (stream === null) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  stream.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });

  if (Reflect.get(stream, "readableEnded") !== true) {
    await once(stream, "end").catch(() => {
      // The stream can close between the state check and listener registration.
    });
  }

  return Buffer.concat(chunks).toString("utf-8").trim();
};

const stopProcessTree = async (processHandle: ChildProcess): Promise<void> => {
  if (processHandle.pid === undefined) {
    return;
  }

  try {
    process.kill(-processHandle.pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(300);

  if (processHandle.exitCode !== null) {
    return;
  }

  try {
    process.kill(-processHandle.pid, "SIGKILL");
  } catch {
    // Ignore: the process group may have already exited.
  }
};

const readMatrixSummary = (
  value: unknown
): {
  allChecksPassed: boolean;
  failedScenarios: string[];
} => {
  if (!(isRecord(value) && isRecord(value.summary))) {
    throw new Error("repl host interop smoke did not return a matrix summary");
  }

  const { summary } = value;

  if (
    typeof summary.allChecksPassed !== "boolean" ||
    !Array.isArray(summary.failedScenarios) ||
    !summary.failedScenarios.every((item) => typeof item === "string")
  ) {
    throw new Error(
      "repl host interop smoke returned an invalid matrix summary"
    );
  }

  return {
    allChecksPassed: summary.allChecksPassed,
    failedScenarios: [...summary.failedScenarios],
  };
};

const ensureInteropArtifacts = async (): Promise<void> => {
  // Defer to Nx for the workspace build graph: `host-repl:build` pulls in
  // `^build` and the explicit `kernel-interop-grpc:codegen` dependency from
  // the engine's (`typescript/runtime`) project.json, so this single invocation produces a fresh
  // `host-repl/dist/index.js` (the module imported below) plus every upstream
  // workspace dist the smoke transitively needs. Earlier revisions hand-rolled
  // 16 sequential `bunx --bun tsup` invocations here, which collapsed under
  // `E2BIG` once Bun's accumulated spawn state reached the host-repl tsup;
  // the Nx executor isolates each underlying tsup call inside its own fresh
  // subprocess and removes that environmental sensitivity. `--skipNxCache`
  // keeps the smoke's evidence freshly measured per ADR-0033 rather than
  // accepting whatever the local Nx cache already retained.
  await runRequiredCommand([
    "bun",
    "run",
    "nx",
    "run",
    "host-repl:build",
    "--skipNxCache",
  ]);
};

const runHeadlessInteropSmoke = async (grpcBaseUrl: string): Promise<void> => {
  const result = await runCliWithInput(
    [
      "node",
      REPL_HOST_CLI_PATH,
      "--headless",
      "--stream-jsonl",
      "--backend",
      "memory",
      "--provider",
      "fixture",
      "--kernel-mode",
      "rust-grpc",
      "--kernel-grpc-base-url",
      grpcBaseUrl,
    ],
    ".turn start streaming\n.turn await\n.mcp smoke\n.exit\n"
  );

  if (result.code !== 0) {
    throw new Error(
      `headless repl host interop smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  const records = parseJsonlRecords(result.stdout);
  const streamEventSeen = records.some(
    (record) =>
      isRecord(record) &&
      record.recordKind === "stream-event" &&
      isRecord(record.event) &&
      record.event.type === "text.delta"
  );
  const mcpOutputSeen = records.some(
    (record) =>
      isRecord(record) &&
      record.recordKind === "output" &&
      typeof record.output === "string" &&
      record.output.includes("mcp.echo")
  );

  if (!(streamEventSeen && mcpOutputSeen)) {
    throw new Error(
      `headless repl host interop smoke did not observe streaming and MCP outputs\nstdout:\n${result.stdout}`
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        headlessInteropSmoke: {
          mcpOutputSeen,
          recordCount: records.length,
          streamEventSeen,
        },
      },
      null,
      2
    )}\n`
  );
};

const renderProcessFailure = async (
  processHandle: ChildProcess,
  prefix = "Rust kernel gRPC service exited before becoming ready"
): Promise<string> => {
  const stdout = await readStream(processHandle.stdout);
  const stderr = await readStream(processHandle.stderr);
  return `${prefix}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
};

const waitForPort = async (
  address: string,
  processHandle: ChildProcess,
  timeoutMs: number
): Promise<void> => {
  const startedAt = Date.now();

  const waitForAttempt = async (): Promise<void> => {
    if (Date.now() - startedAt >= timeoutMs) {
      await stopProcessTree(processHandle);
      throw new Error(
        await renderProcessFailure(
          processHandle,
          "timed out waiting for Rust kernel gRPC service"
        )
      );
    }

    if (processHandle.exitCode !== null) {
      throw new Error(await renderProcessFailure(processHandle));
    }

    if (await canConnect(address)) {
      return;
    }

    await delay(200);
    await waitForAttempt();
  };

  await waitForAttempt();
};

const main = async (): Promise<void> => {
  await ensureInteropArtifacts();
  const port = await reservePort();
  const grpcAddress = `127.0.0.1:${port}`;
  const grpcBaseUrl = `http://${grpcAddress}`;
  const service = spawnRustKernelService(grpcAddress);

  try {
    await waitForPort(grpcAddress, service, WAIT_TIMEOUT_MS);
    const replHost = await loadReplHostModule();
    const scenarios = [...replHost.DEFAULT_REPL_SCENARIOS, "reload"] as const;
    const report = await replHost.runReplScenarioMatrix({
      config: {
        backend: "memory",
        kernelGrpcBaseUrl: grpcBaseUrl,
        kernelMode: "rust-grpc",
        modelId: undefined,
        providerMode: "fixture",
        sqlitePath: undefined,
      },
      scenarios,
    });

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    const summary = readMatrixSummary(report);

    if (!summary.allChecksPassed) {
      throw new Error(
        `repl host interop smoke failed for scenarios: ${summary.failedScenarios.join(", ")}`
      );
    }

    await runHeadlessInteropSmoke(grpcBaseUrl);
  } finally {
    await stopProcessTree(service);
  }
};

await main();
