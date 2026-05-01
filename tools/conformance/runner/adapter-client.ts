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

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
  AdapterCapabilities,
  AdapterControls,
  AdapterErrorEnvelope,
  OperationOutcome,
} from "../adapter-protocol/index.js";

export interface AdapterManifest {
  adapterId: string;
  authorityPackets: string[];
  boundary: string;
  capabilities: string[];
  command: string[];
  implementationId: string;
  language: string;
  protocol: {
    name: "tuvren.conformance-adapter";
    transport: "json-rpc-2.0-stdio";
    version: string;
  };
  suiteId: string;
  suiteVersion: string;
}

export interface JsonRpcClientOptions {
  command: readonly string[];
  cwd: string;
  timeoutMs?: number;
}

interface JsonRpcSuccessResponse {
  id: number | string | null;
  jsonrpc: "2.0";
  result: unknown;
}

interface JsonRpcErrorResponse {
  error: AdapterErrorEnvelope;
  id: number | string | null;
  jsonrpc: "2.0";
}

type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcSuccessResponse;

export class JsonRpcAdapterError extends Error {
  readonly envelope: AdapterErrorEnvelope;

  constructor(envelope: AdapterErrorEnvelope) {
    super(`${envelope.code}: ${envelope.message}`);
    this.name = "JsonRpcAdapterError";
    this.envelope = envelope;
  }
}

export class JsonRpcAdapterClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private nextId = 1;
  private exited = false;
  private readonly pending = new Map<
    number,
    {
      reject(error: Error): void;
      resolve(value: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stderr = "";
  private readonly timeoutMs: number;

  constructor(options: JsonRpcClientOptions) {
    const [command, ...args] = options.command;

    if (command === undefined) {
      throw new Error("adapter command must not be empty");
    }

    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = createInterface({ input: this.child.stdout });

    this.lines.on("line", (line) => {
      this.handleLine(line);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const message = `adapter process exited before completing all requests: code=${String(
        code
      )} signal=${String(signal)}${this.stderr.length > 0 ? ` stderr=${this.stderr}` : ""}`;

      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }

      this.pending.clear();
    });
  }

  async initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    const value = await this.request("initialize", { packetId, planVersion });

    if (!isRecord(value) || typeof value.adapterId !== "string") {
      throw new Error("adapter initialize returned invalid capabilities");
    }

    return value as unknown as AdapterCapabilities;
  }

  async createInstance(input: unknown): Promise<unknown> {
    return await this.request("createInstance", { input });
  }

  async dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown,
    timeoutMs?: number
  ): Promise<OperationOutcome> {
    const value = await this.request(
      "dispatch",
      {
        controls,
        input,
        instance,
        operation,
      },
      timeoutMs
    );

    if (!isOperationOutcome(value)) {
      throw new Error("adapter dispatch returned invalid OperationOutcome");
    }

    return value;
  }

  async events(
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown,
    timeoutMs?: number
  ): Promise<unknown[]> {
    const value = await this.request(
      "events",
      {
        controls,
        input,
        instance,
        operation,
      },
      timeoutMs
    );

    if (value === null || value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error("adapter events returned a non-array payload");
    }

    return value;
  }

  async inspectState(
    query: unknown,
    instance?: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    return await this.request("inspectState", { instance, query }, timeoutMs);
  }

  async destroyInstance(instance: unknown): Promise<void> {
    await this.request("destroyInstance", { instance });
  }

  async shutdown(): Promise<void> {
    try {
      if (
        !this.exited &&
        this.child.exitCode === null &&
        this.child.stdin.writable
      ) {
        await this.request("shutdown", {});
      }
    } catch {
      // Adapter shutdown is best-effort; request failures are already isolated
      // at check scope, and this path must only reclaim the process.
    } finally {
      this.lines.close();
      this.child.stdin.end();
      if (this.child.exitCode === null) {
        this.child.kill();
      }
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;

    return new Promise((resolve, reject) => {
      // Plan deadlines bound host protocol requests too; adapters still receive
      // controls.deadlineMs so native cancellation semantics remain observable.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`adapter request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      this.child.stdin.write(payload, "utf8", (error) => {
        if (error !== null && error !== undefined) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleLine(line: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      this.rejectAll(
        new Error(
          `adapter stdout contained malformed JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
      return;
    }

    if (!isJsonRpcResponse(parsed) || typeof parsed.id !== "number") {
      this.rejectAll(new Error("adapter stdout contained malformed JSON-RPC"));
      return;
    }

    const pending = this.pending.get(parsed.id);

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if ("error" in parsed) {
      pending.reject(new JsonRpcAdapterError(parsed.error));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !("id" in value)) {
    return false;
  }

  if ("result" in value) {
    return !("error" in value);
  }

  return "error" in value && isAdapterErrorEnvelope(value.error);
}

function isOperationOutcome(value: unknown): value is OperationOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "result") {
    return "value" in value;
  }

  return value.kind === "error" && isAdapterErrorEnvelope(value.error);
}

function isAdapterErrorEnvelope(value: unknown): value is AdapterErrorEnvelope {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string"
  ) {
    return false;
  }

  return value.cause === undefined || isAdapterErrorEnvelope(value.cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
