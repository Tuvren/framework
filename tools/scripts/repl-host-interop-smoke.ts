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

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "./lib/command-runner.js";

interface ReplHostInteropModule {
  DEFAULT_REPL_SCENARIOS: readonly string[];
  runReplScenarioMatrix(input: {
    config: {
      backend: "memory";
      kernelGrpcBaseUrl: string;
      kernelMode: "rust-grpc";
      modelId?: string;
      providerMode: "fixture";
      sqlitePath?: string;
    };
    scenarios: readonly string[];
  }): Promise<unknown>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPL_HOST_DIST_PATH = resolve(
  REPO_ROOT,
  "boundaries/hosts/implementations/typescript/repl/dist/index.js"
);
// Epic X moved the TypeScript contract package roots under
// implementations/typescript while leaving neutral specs and generated
// artifacts at the contract roots, so the smoke builds runnable JS from the
// implementation roots after codegen refreshes the contract-root artifacts.
const INTEROP_BUILD_DIRECTORIES: readonly string[] = [
  "boundaries/shared/contracts/core-types/implementations/typescript",
  "boundaries/framework/contracts/runtime-api/implementations/typescript",
  "boundaries/framework/contracts/driver-api/implementations/typescript",
  "boundaries/providers/contracts/provider-api/implementations/typescript",
  "boundaries/kernel/contracts/protocol/implementations/typescript",
  "boundaries/kernel/implementations/typescript/backend-memory",
  "boundaries/kernel/implementations/typescript/backend-sqlite",
  "boundaries/framework/implementations/typescript/drivers/react",
  "boundaries/framework/implementations/typescript/stream-core",
  "boundaries/framework/implementations/typescript/stream-sse",
  "boundaries/framework/implementations/typescript/stream-agui",
  "boundaries/providers/implementations/typescript/bridge-ai-sdk",
  "boundaries/framework/implementations/typescript/runtime-core",
  "boundaries/kernel/implementations/typescript/runtime-kernel",
  "boundaries/framework/implementations/typescript/runtime",
  "boundaries/hosts/implementations/typescript/repl",
];
const WAIT_TIMEOUT_MS = 30_000;

await main();

async function main(): Promise<void> {
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
  } finally {
    await stopProcessTree(service);
  }
}

async function ensureInteropArtifacts(): Promise<void> {
  // The authoritative interop smoke owns the exact prerequisites it executes:
  // generate the governed bindings first, then emit only the runnable JS
  // bundles the smoke imports at runtime. This intentionally avoids unrelated
  // declaration-generation or Nx task-graph fan-out so the lane stays focused
  // on the real TypeScript-to-Rust execution seam.
  await runRequiredCommand([
    "bun",
    "run",
    "nx",
    "run",
    "kernel-interop-grpc:codegen",
    "--skipNxCache",
  ]);

  for (const directory of INTEROP_BUILD_DIRECTORIES) {
    await runRequiredCommand(
      ["bunx", "--bun", "tsup", "--config", "tsup.config.ts"],
      { cwd: resolve(REPO_ROOT, directory) }
    );
  }
}

async function loadReplHostModule(): Promise<ReplHostInteropModule> {
  const moduleUrl = pathToFileURL(REPL_HOST_DIST_PATH).href;
  return (await import(moduleUrl)) as ReplHostInteropModule;
}

function spawnRustKernelService(address: string): ChildProcess {
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
}

async function runRequiredCommand(
  command: readonly string[],
  options?: { cwd?: string }
): Promise<void> {
  const result = await runCommand(command, {
    cwd: options?.cwd ?? REPO_ROOT,
  });

  if (result.code !== 0) {
    throw new Error(`command failed: ${command.join(" ")}`);
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve an IPv4 TCP port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolvePort(port);
      });
    });
    server.once("error", reject);
  });
}

async function waitForPort(
  address: string,
  processHandle: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (processHandle.exitCode !== null) {
      throw new Error(await renderProcessFailure(processHandle));
    }

    if (await canConnect(address)) {
      return;
    }

    await delay(200);
  }

  await stopProcessTree(processHandle);
  throw new Error(
    await renderProcessFailure(
      processHandle,
      "timed out waiting for Rust kernel gRPC service"
    )
  );
}

async function canConnect(address: string): Promise<boolean> {
  const [host, portText] = address.split(":");

  if (host === undefined || portText === undefined) {
    return false;
  }

  const port = Number(portText);

  return await new Promise<boolean>((resolveConnect) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolveConnect(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function renderProcessFailure(
  processHandle: ChildProcess,
  prefix = "Rust kernel gRPC service exited before becoming ready"
): Promise<string> {
  const stdout = await readStream(processHandle.stdout);
  const stderr = await readStream(processHandle.stderr);
  return `${prefix}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
}

async function readStream(
  stream: NodeJS.ReadableStream | null
): Promise<string> {
  if (stream === null) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  stream.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });

  if (
    (stream as NodeJS.ReadableStream & { readableEnded?: boolean })
      .readableEnded !== true
  ) {
    await once(stream, "end").catch(() => undefined);
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

async function stopProcessTree(processHandle: ChildProcess): Promise<void> {
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
}

function readMatrixSummary(value: unknown): {
  allChecksPassed: boolean;
  failedScenarios: string[];
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("summary" in value) ||
    typeof value.summary !== "object" ||
    value.summary === null
  ) {
    throw new Error("repl host interop smoke did not return a matrix summary");
  }

  const summary = value.summary as {
    allChecksPassed?: unknown;
    failedScenarios?: unknown;
  };

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
}
