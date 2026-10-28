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
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { Writable } from "node:stream";
import type { WritableStreamDefaultWriter } from "node:stream/web";

import type {
  AdapterCapabilities,
  AdapterControls,
  AdapterErrorEnvelope,
  OperationOutcome,
} from "../adapter-protocol/index.js";
import { validateAdapterDefinition } from "../adapter-protocol/protocol-contract.js";
import { JsonRpcAdapterError } from "./adapter-error.js";
import { assertLosslessFrame } from "./observation-encoding.js";

export interface AdapterManifest {
  adapterId: string;
  authorityPackets: string[];
  boundary: string;
  capabilities: string[];
  command: string[];
  executable?: string;
  implementationId: string;
  language: string;
  profiles?: string[];
  storage?: "none" | "postgres-database" | "sqlite-directory";
  protocol: {
    name: "tuvren.conformance-adapter";
    transport: "json-rpc-2.0-stdio";
    version: string;
  };
  suiteId: string;
  suiteVersion: string;
}

export const adapterCommand = (
  manifest: Pick<AdapterManifest, "command" | "executable">
): string[] =>
  manifest.executable === undefined
    ? manifest.command
    : [manifest.executable, ...manifest.command.slice(1)];

export interface JsonRpcClientOptions {
  command: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  processGroup?: boolean;
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

export interface AdapterFrame {
  atMs: number;
  direction: "receive" | "send";
  frame: string;
}

export interface AdapterExit {
  code: number | null;
  signal: string | null;
}

/** Position in the frame and stderr streams where a check began. */
export interface AdapterTranscriptMark {
  frameSequence: number;
  startedAt: number;
  stderrOffset: number;
}

interface RecordedFrame {
  at: number;
  direction: AdapterFrame["direction"];
  frame: string;
  sequence: number;
}

const MAX_PREVIEW_FRAMES = 256;
const MAX_PREVIEW_FRAME_CHARS = 4096;
const MAX_RETAINED_STDERR_CHARS = 65_536;

const truncate = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}...[${text.length - limit} more chars]`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A bounded preview of a frame log; the complete log is retained elsewhere. */
export const previewFrames = (frames: readonly unknown[]): unknown[] => {
  const kept = frames
    .slice(-MAX_PREVIEW_FRAMES)
    .map((entry) =>
      isRecord(entry) && typeof entry.frame === "string"
        ? { ...entry, frame: truncate(entry.frame, MAX_PREVIEW_FRAME_CHARS) }
        : entry
    );
  const omittedFrames = frames.length - kept.length;
  return omittedFrames > 0 ? [{ omittedFrames }, ...kept] : kept;
};

const isAdapterErrorEnvelope = (
  value: unknown
): value is AdapterErrorEnvelope => {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string"
  ) {
    return false;
  }

  return value.cause === undefined || isAdapterErrorEnvelope(value.cause);
};

const isJsonRpcId = (value: unknown): value is number | string | null =>
  value === null || typeof value === "number" || typeof value === "string";

const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse => {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !("id" in value)) {
    return false;
  }

  if (!isJsonRpcId(value.id)) {
    return false;
  }

  if ("result" in value) {
    return !("error" in value);
  }

  return "error" in value && isAdapterErrorEnvelope(value.error);
};

const isOperationOutcome = (value: unknown): value is OperationOutcome => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "result") {
    return "value" in value;
  }

  return value.kind === "error" && isAdapterErrorEnvelope(value.error);
};

export class JsonRpcAdapterClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly writer: WritableStreamDefaultWriter<unknown>;
  private nextId = 1;
  private losslessObservations = false;
  private exited = false;
  private sessionFailure: Error | undefined;
  private readonly pending = new Map<
    number,
    {
      lossless: boolean;
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stderr = "";
  private stderrTotal = 0;
  private readonly frames: RecordedFrame[] = [];
  private readonly faultReceipts: {
    token: string;
    processEpoch: number;
    phase: string;
    sequence: number;
  }[] = [];
  private frameSequence = 0;
  private exit: AdapterExit | undefined;
  private supervisorTerminated = false;
  private clientClosed = false;
  private readonly closed: Promise<void>;
  private readonly timeoutMs: number;
  private readonly processGroup: boolean;

  constructor(options: JsonRpcClientOptions) {
    const [command, ...args] = options.command;

    if (command === undefined) {
      throw new Error("adapter command must not be empty");
    }

    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.processGroup = options.processGroup === true;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      detached: this.processGroup,
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.writer = Writable.toWeb(this.child.stdin).getWriter();

    this.lines.on("line", (line) => {
      this.recordFrame("receive", line);
      this.handleLine(line);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stderrTotal += text.length;
      this.stderr = (this.stderr + text).slice(-MAX_RETAINED_STDERR_CHARS);
    });
    const closed = Promise.withResolvers<void>();
    this.closed = closed.promise;
    this.child.on("close", () => {
      closed.resolve();
    });
    this.child.on("error", (error) => {
      this.failSession(error);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exit = { code, signal };
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

  setLosslessObservations(enabled: boolean): void {
    this.losslessObservations = enabled;
  }

  async initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    const value = await this.request("initialize", { packetId, planVersion });

    if (
      !isRecord(value) ||
      typeof value.adapterId !== "string" ||
      typeof value.packetId !== "string" ||
      typeof value.planVersion !== "string" ||
      !Array.isArray(value.capabilities) ||
      !value.capabilities.every(
        (entry: unknown) => typeof entry === "string"
      ) ||
      (value.protocolVersion !== undefined &&
        value.protocolVersion !== "0.1.0" &&
        value.protocolVersion !== "0.2.0") ||
      (value.profiles !== undefined &&
        !(
          Array.isArray(value.profiles) &&
          value.profiles.every((entry: unknown) => typeof entry === "string")
        )) ||
      (value.storageKinds !== undefined &&
        !(
          Array.isArray(value.storageKinds) &&
          value.storageKinds.every(
            (entry: unknown) =>
              entry === "none" ||
              entry === "postgres-database" ||
              entry === "sqlite-directory"
          )
        ))
    ) {
      throw new Error("adapter initialize returned invalid capabilities");
    }

    return {
      adapterId: value.adapterId,
      capabilities: value.capabilities,
      packetId: value.packetId,
      planVersion: value.planVersion,
      ...(value.protocolVersion === undefined
        ? {}
        : { protocolVersion: value.protocolVersion }),
      ...(value.profiles === undefined ? {} : { profiles: value.profiles }),
      ...(value.storageKinds === undefined
        ? {}
        : { storageKinds: value.storageKinds }),
    };
  }

  async createInstance(
    input: unknown,
    options: {
      storageRef?: string;
      scope?: string;
      clock?: Record<string, unknown>;
    } = {}
  ): Promise<unknown> {
    return await this.request("createInstance", { input, ...options });
  }

  async openInstance(storageRef: string, scope?: string): Promise<unknown> {
    return await this.request("openInstance", {
      storageRef,
      ...(scope === undefined ? {} : { scope }),
    });
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

  async startOperation(
    operation: string,
    argumentsValue: unknown,
    instance: unknown,
    timeoutMs?: number
  ): Promise<{ operationHandle: string }> {
    const value = await this.request(
      "startOperation",
      { arguments: argumentsValue, instance, operation },
      timeoutMs
    );
    if (
      validateAdapterDefinition("StartOperationResult", value).length > 0 ||
      !isRecord(value) ||
      typeof value.operationHandle !== "string" ||
      value.operationHandle.length === 0 ||
      Object.keys(value).length !== 1
    ) {
      throw new Error(
        "adapter startOperation returned invalid operation handle"
      );
    }
    return { operationHandle: value.operationHandle };
  }

  async armFault(
    instance: unknown,
    point: string,
    selector: unknown,
    occurrence: number,
    mode: "throw" | "block"
  ): Promise<{ token: string }> {
    const value = await this.request("armFault", {
      instance,
      point,
      selector,
      occurrence,
      mode,
    });
    if (
      !isRecord(value) ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      Object.keys(value).length !== 1
    ) {
      throw new Error("adapter armFault returned invalid token");
    }
    return { token: value.token };
  }

  async waitForFaultReached(
    token: string,
    timeoutMs: number,
    afterSequence: number
  ): Promise<{ token: string; processEpoch: number; phase: string }> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const index = this.faultReceipts.findIndex(
        (receipt) => receipt.token === token
      );
      if (index >= 0) {
        const [receipt] = this.faultReceipts.splice(index, 1);
        if (receipt !== undefined) {
          if (receipt.sequence <= afterSequence) {
            throw new Error("faultReached preceded the attempted operation");
          }
          return {
            token: receipt.token,
            processEpoch: receipt.processEpoch,
            phase: receipt.phase,
          };
        }
      }
      if (this.sessionFailure !== undefined) {
        throw this.sessionFailure;
      }
      if (this.exited) {
        throw new Error("adapter exited before faultReached");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`faultReached timed out for ${token}`);
  }

  async awaitOperation(
    operationHandle: string,
    timeoutMs?: number
  ): Promise<OperationOutcome> {
    const value = await this.request(
      "awaitOperation",
      { operationHandle },
      timeoutMs
    );
    if (!isOperationOutcome(value)) {
      throw new Error(
        "adapter awaitOperation returned invalid OperationOutcome"
      );
    }
    return value;
  }

  async cancelOperation(
    operationHandle: string,
    reason: string,
    timeoutMs?: number
  ): Promise<void> {
    await this.request(
      "cancelOperation",
      { operationHandle, reason },
      timeoutMs
    );
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
      throw new TypeError("adapter events returned a non-array payload");
    }

    const events: unknown[] = value;
    return events;
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
    if (this.clientClosed) {
      return;
    }
    this.clientClosed = true;
    try {
      if (
        !this.exited &&
        this.child.exitCode === null &&
        this.child.stdin.writable
      ) {
        await this.request(
          "shutdown",
          {},
          this.processGroup ? 5000 : this.timeoutMs
        );
      }
    } catch {
      // Adapter shutdown is best-effort; request failures are already isolated
      // at check scope, and this path must only reclaim the process.
    }
    this.lines.close();
    this.writer.releaseLock();
    this.child.stdin.end();
    if (
      this.child.pid !== undefined &&
      (await this.terminationStatus(this.processGroup ? 5000 : 2000)) ===
        undefined
    ) {
      this.signal("SIGTERM");
      if ((await this.terminationStatus()) === undefined) {
        this.signal("SIGKILL");
        if ((await this.terminationStatus()) === undefined) {
          throw new Error("adapter process did not exit after SIGKILL");
        }
      }
    }
  }

  async terminate(signal: NodeJS.Signals): Promise<AdapterExit> {
    if (!this.exited) {
      this.signal(signal);
    }
    const exit = await this.terminationStatus();
    if (exit === undefined) {
      throw new Error(`adapter failed to exit after ${signal}`);
    }
    return exit;
  }

  /** Starts a check's transcript and releases frames of earlier checks. */
  markTranscript(): AdapterTranscriptMark {
    this.frames.length = 0;
    return {
      frameSequence: this.frameSequence,
      startedAt: performance.now(),
      stderrOffset: this.stderrTotal,
    };
  }

  latestArrivalSequence(): number {
    const frame = this.frames.findLast(
      (entry) => entry.direction === "receive"
    );
    if (frame === undefined) {
      throw new Error("no received adapter frame");
    }
    return frame.sequence;
  }

  nextFrameSequence(): number {
    return this.frameSequence;
  }

  framesSince(mark: AdapterTranscriptMark): AdapterFrame[] {
    return this.frames
      .filter((entry) => entry.sequence >= mark.frameSequence)
      .map((entry) => ({
        atMs: Math.round((entry.at - mark.startedAt) * 1000) / 1000,
        direction: entry.direction,
        frame: entry.frame,
      }));
  }

  /** Stderr written since the mark, bounded to the retained buffer. */
  stderrSince(mark: AdapterTranscriptMark): string {
    const written = this.stderrTotal - mark.stderrOffset;
    return written <= 0 ? "" : this.stderr.slice(-written);
  }

  stderrTail(limit: number): string {
    return this.stderr.slice(-limit);
  }

  /**
   * The adapter's exit status once it has exited, after its stdio streams
   * close or a short grace period so trailing stderr is captured.
   */
  async exitStatus(graceMs = 1000): Promise<AdapterExit | undefined> {
    if (this.exit === undefined) {
      return undefined;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
    return this.exit;
  }

  async terminationStatus(graceMs = 2000): Promise<AdapterExit | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
    return this.exit;
  }

  processId(): number | undefined {
    return this.child.pid;
  }

  wasTerminatedBySupervisor(): boolean {
    return this.supervisorTerminated;
  }

  private recordFrame(
    direction: AdapterFrame["direction"],
    line: string
  ): void {
    this.frames.push({
      at: performance.now(),
      direction,
      frame: line,
      sequence: this.frameSequence,
    });
    this.frameSequence += 1;
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<unknown> {
    if (this.sessionFailure !== undefined) {
      throw this.sessionFailure;
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;

    const response = Promise.withResolvers<unknown>();
    // Start the deadline before writing, and keep responses independent of the
    // write callback so an adapter reply or timeout can settle immediately.
    const timer = setTimeout(() => {
      this.pending.delete(id);
      response.reject(new Error(`adapter request timed out: ${method}`));
    }, timeoutMs);
    this.pending.set(id, {
      lossless: this.losslessObservations,
      reject: response.reject,
      resolve: (value: unknown) => {
        response.resolve(value);
      },
      timer,
    });
    this.recordFrame("send", payload.trimEnd());
    const writeRequest = async (): Promise<unknown> => {
      try {
        await this.writer.write(payload);
      } catch (error: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        throw error;
      }
      return await response.promise;
    };
    return await Promise.race([response.promise, writeRequest()]);
  }

  private recordNotification(frame: Record<string, unknown>): void {
    if (validateAdapterDefinition("JsonRpcNotification", frame).length !== 0) {
      throw new Error(
        "adapter stdout contained malformed JSON-RPC notification"
      );
    }
    const params = frame.params;
    if (
      frame.method === "faultReached" &&
      isRecord(params) &&
      typeof params.token === "string" &&
      typeof params.processEpoch === "number" &&
      typeof params.phase === "string"
    ) {
      this.faultReceipts.push({
        token: params.token,
        processEpoch: params.processEpoch,
        phase: params.phase,
        sequence: this.frameSequence - 1,
      });
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      this.failSession(
        new Error(
          `adapter stdout contained malformed JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    const id =
      isRecord(parsed) && typeof parsed.id === "number" ? parsed.id : undefined;
    const pendingFrame = id === undefined ? undefined : this.pending.get(id);
    try {
      if (pendingFrame?.lossless === true) {
        assertLosslessFrame(line);
      }
      if (isRecord(parsed) && !("id" in parsed)) {
        this.recordNotification(parsed);
        return;
      }
      if (!isJsonRpcResponse(parsed)) {
        throw new Error("adapter stdout contained malformed JSON-RPC");
      }
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectFrame(id, failure);
      return;
    }

    if (typeof parsed.id !== "number") {
      if ("error" in parsed) {
        this.failSession(new JsonRpcAdapterError(parsed.error));
      }
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

  private rejectFrame(id: number | undefined, error: Error): void {
    if (id === undefined) {
      this.failSession(error);
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private failSession(error: Error): void {
    this.sessionFailure = error;
    this.signal("SIGTERM");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (this.processGroup && pid !== undefined) {
      try {
        process.kill(-pid, signal);
        this.supervisorTerminated = true;
      } catch (error: unknown) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          throw error;
        }
      }
      return;
    }
    this.supervisorTerminated = this.child.kill(signal);
  }
}
