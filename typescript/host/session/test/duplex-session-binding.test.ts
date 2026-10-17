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

import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  InputSignal,
} from "@tuvren/core/execution";
import type { ApprovalResponse } from "@tuvren/core/tools";

import { createSessionClient } from "../../session-client/src/index.ts";
import type { SessionClientSocket } from "../../session-client/src/index.ts";
import { createDuplexSessionBinding } from "../src/lib/duplex-session-binding.ts";
import type {
  SessionOutboundFrame,
  SessionRejectionFrame,
} from "../src/lib/session-frame-shapes.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("expected an object");
  }
  return value;
};

// ---------------------------------------------------------------------------
// Fake ExecutionHandle double
// ---------------------------------------------------------------------------

/** A controllable single-consumer async event source for the fake handle. */
class FakeEventSource implements AsyncIterable<TuvrenStreamEvent> {
  private readonly items: TuvrenStreamEvent[] = [];
  private readonly waiters: ((
    result: IteratorResult<TuvrenStreamEvent>
  ) => void)[] = [];
  private closed = false;
  private claimed = false;

  emit(event: TuvrenStreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: event });
      return;
    }
    this.items.push(event);
  }

  end(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TuvrenStreamEvent> {
    if (this.claimed) {
      throw new Error("FakeEventSource consumed twice");
    }
    this.claimed = true;
    return {
      next: async (): Promise<IteratorResult<TuvrenStreamEvent>> => {
        const value = this.items.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        const pending =
          Promise.withResolvers<IteratorResult<TuvrenStreamEvent>>();
        this.waiters.push(pending.resolve);
        return await pending.promise;
      },
    };
  }
}

interface FakeHandleCalls {
  cancel: number;
  resolveApproval: ApprovalResponse[];
  steer: InputSignal[];
}

interface FakeHandle {
  calls: FakeHandleCalls;
  events: FakeEventSource;
  handle: ExecutionHandle;
  setPhase: (phase: ExecutionStatus["phase"]) => void;
  /** Settle the awaitResult() promise (reject when `error` is provided). */
  settleResult: (error?: unknown) => void;
}

const makeFakeHandle = (
  options: {
    phase?: ExecutionStatus["phase"];
    onResolveApproval?: (response: ApprovalResponse) => ExecutionHandle;
    onSteer?: (signal: InputSignal) => void;
    onCancel?: () => void;
  } = {}
): FakeHandle => {
  const events = new FakeEventSource();
  const calls: FakeHandleCalls = { cancel: 0, resolveApproval: [], steer: [] };
  let phase: ExecutionStatus["phase"] = options.phase ?? "running";

  const result = Promise.withResolvers<ExecutionResult>();

  const handle: ExecutionHandle = {
    async awaitResult(): Promise<ExecutionResult> {
      return await result.promise;
    },
    cancel(): void {
      calls.cancel += 1;
      if (options.onCancel !== undefined) {
        options.onCancel();
      }
    },
    events(): AsyncIterable<TuvrenStreamEvent> {
      return events;
    },
    resolveApproval(response: ApprovalResponse): ExecutionHandle {
      calls.resolveApproval.push(response);
      if (options.onResolveApproval !== undefined) {
        return options.onResolveApproval(response);
      }
      throw new Error("resolveApproval not configured");
    },
    status(): ExecutionStatus {
      return { iterationCount: 0, phase };
    },
    steer(signal: InputSignal): void {
      calls.steer.push(signal);
      if (options.onSteer !== undefined) {
        options.onSteer(signal);
      }
    },
  };

  return {
    calls,
    events,
    handle,
    setPhase(nextPhase: ExecutionStatus["phase"]): void {
      phase = nextPhase;
    },
    settleResult(error?: unknown): void {
      if (error === undefined) {
        result.resolve({
          executionStatus: { iterationCount: 0, phase: "completed" },
          status: "completed",
        });
        return;
      }
      result.reject(error);
    },
  };
};

const collectFrames = async (
  iterable: AsyncIterable<SessionOutboundFrame>,
  count: number
): Promise<SessionOutboundFrame[]> => {
  const collected: SessionOutboundFrame[] = [];
  // Preserve the caller's iterator across partial reads; a for-await break
  // would call return() and close the session's outbound queue.
  const iterator = iterable[Symbol.asyncIterator]();
  const collectNext = async (): Promise<void> => {
    const result = await iterator.next();
    if (result.done === true) {
      return;
    }
    collected.push(result.value);
    if (collected.length < count) {
      await collectNext();
    }
  };
  if (count > 0) {
    await collectNext();
  }
  return collected;
};

const rejection = (
  frame: SessionOutboundFrame
): SessionRejectionFrame["rejection"] => {
  if (frame.kind !== "session_rejection") {
    throw new Error(`expected session_rejection frame, got "${frame.kind}"`);
  }
  return frame.rejection;
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject");
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDuplexSessionBinding", () => {
  test("session client file bytes round-trip through JSON into the binding", () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "client-binding-roundtrip",
    });
    const sent: unknown[] = [];
    const socket: SessionClientSocket = {
      close: () => {},
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
      send: (data) => {
        const parsed: unknown = JSON.parse(data);
        sent.push(parsed);
      },
    };
    const client = createSessionClient({
      capabilities: {},
      sessionId: binding.sessionId,
      url: "wss://example.invalid/session",
      webSocketFactory: () => socket,
    });
    client.connect();
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        kind: "handshake_ack",
        protocolVersion: "1",
        resumeStatus: "none",
        sessionId: binding.sessionId,
      }),
    });

    const emptyBytes = new Uint8Array([]);
    const bytes = new Uint8Array([0, 7, 255]);
    const signal = {
      extra: "signal-extra",
      parts: [
        {
          data: emptyBytes,
          mediaType: "application/octet-stream",
          providerMetadata: { source: "test" },
          type: "file" as const,
        },
        {
          data: bytes,
          extra: "preserved",
          filename: "payload.bin",
          mediaType: "application/octet-stream",
          providerMetadata: { nested: { retained: true }, source: "test" },
          type: "file" as const,
        },
        { data: "text bytes", mediaType: "text/plain", type: "file" as const },
      ],
    };
    client.steer(signal);
    const { frame: rawFrame } = requiredRecord(sent.at(-1));
    const frame = requiredRecord(rawFrame);
    const { signal: serializedSignal } = frame;
    binding.dispatchInbound(frame);

    const [received] = fake.calls.steer;
    expect(
      received === undefined
        ? null
        : Object.getOwnPropertyDescriptor(received, "extra")?.value
    ).toBe("signal-extra");
    expect(received?.parts[0]?.type).toBe("file");
    expect(received?.parts[1]?.type).toBe("file");
    expect(received?.parts[2]?.type).toBe("file");
    for (const [index, expected] of [[], [0, 7, 255]].entries()) {
      const part = received?.parts[index];
      if (part?.type !== "file" || !(part.data instanceof Uint8Array)) {
        throw new Error("expected binding to restore file bytes");
      }
      expect([...part.data]).toEqual(expected);
    }
    expect(received?.parts[2]).toMatchObject({ data: "text bytes" });
    expect(received?.parts[0]).toMatchObject({
      providerMetadata: { source: "test" },
    });
    expect(received?.parts[1]).toMatchObject({
      extra: "preserved",
      filename: "payload.bin",
      providerMetadata: { nested: { retained: true }, source: "test" },
    });
    expect(JSON.stringify(serializedSignal)).toContain('"data":[]');
    expect(JSON.stringify(serializedSignal)).toContain('"data":[0,7,255]');
    expect([...emptyBytes]).toEqual([]);
    expect([...bytes]).toEqual([0, 7, 255]);
    client.close();
  });

  test("complete payload guards preserve identity, extra fields, and duplicate approval decisions", () => {
    const replacement = makeFakeHandle();
    const fake = makeFakeHandle({
      onResolveApproval: () => replacement.handle,
    });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "guard-valid",
    });
    const signal: InputSignal = {
      parts: [
        { providerMetadata: { opaque: undefined }, text: "", type: "text" },
        { redacted: true, text: "", type: "reasoning" },
        { callId: "call", input: undefined, name: "tool", type: "tool_call" },
        {
          callId: "call",
          isError: false,
          name: "tool",
          output: null,
          type: "tool_result",
        },
        {
          data: new Uint8Array([1]),
          filename: "",
          mediaType: "application/octet-stream",
          type: "file",
        },
        { data: undefined, name: "", type: "structured" },
      ],
    };
    const extendedSignal = { ...signal, extra: "retained" };
    binding.dispatchInbound({
      correlationId: "steer",
      kind: "steer",
      protocolVersion: "1",
      sessionId: binding.sessionId,
      signal: extendedSignal,
    });
    expect(fake.calls.steer[0]).toBe(extendedSignal);

    const response = {
      decisions: [
        { callId: "call", extra: 1, type: "custom" },
        {
          callId: "call",
          editedInput: undefined,
          message: "approved",
          type: "edit",
        },
      ],
      extra: true,
    };
    binding.dispatchInbound({
      correlationId: "approval",
      kind: "approval_response",
      protocolVersion: "1",
      response,
      sessionId: binding.sessionId,
    });
    expect(fake.calls.resolveApproval[0]).toBe(response);
    expect(binding.currentHandle()).toBe(replacement.handle);
  });

  test("authority-valid JSON file bytes project to core byte arrays at dispatch", () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "json-file-bytes",
    });
    const byteArrays = [[], [1, 2], [0, 255]];

    for (const [index, data] of byteArrays.entries()) {
      const signal = {
        extra: `signal-${index}`,
        parts: [
          {
            data,
            filename: "payload.bin",
            mediaType: "application/octet-stream",
            providerMetadata: { retained: true },
            type: "file",
          },
        ],
      };
      const original = [...data];
      binding.dispatchInbound({
        correlationId: `bytes-${index}`,
        kind: "steer",
        protocolVersion: "1",
        sessionId: binding.sessionId,
        signal,
      });

      const received = fake.calls.steer[index];
      const file = received?.parts[0];
      expect(file?.type).toBe("file");
      if (file?.type !== "file") {
        throw new Error("expected file part");
      }
      if (!(file.data instanceof Uint8Array)) {
        throw new Error("expected projected Uint8Array data");
      }
      expect([...file.data]).toEqual(original);
      expect(data).toEqual(original);
      expect(Object.getOwnPropertyDescriptor(received, "extra")?.value).toBe(
        `signal-${index}`
      );
      expect(file.filename).toBe("payload.bin");
      expect(file.providerMetadata).toEqual({ retained: true });
    }
  });

  test("invalid nested fields reject once before touching the handle, preserving envelope precedence", async () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "guard-invalid",
    });
    const outbound = binding.outbound();
    const sparseBytes: number[] = [];
    sparseBytes.length = 1;
    const payloads = [
      {
        kind: "client_result",
        result: {
          callId: " ",
          content: null,
          leaseToken: "lease",
        },
      },
      {
        kind: "client_result",
        result: {
          callId: "call",
          content: null,
          leaseToken: "\t",
        },
      },
      {
        kind: "client_result",
        result: {
          callId: "call",
          content: null,
          isError: "false",
          leaseToken: "lease",
        },
      },
      { kind: "approval_response", response: { decisions: [null] } },
      {
        kind: "approval_response",
        response: { decisions: [{ callId: "call", type: 1 }] },
      },
      {
        kind: "approval_response",
        response: {
          decisions: [{ callId: "call", message: " ", type: "approve" }],
        },
      },
      {
        kind: "approval_response",
        response: { decisions: [{ callId: "\n", type: "approve" }] },
      },
      ...[
        null,
        { text: 1, type: "text" },
        { redacted: "true", text: "reason", type: "reasoning" },
        { redacted: false, text: "", type: "reasoning" },
        { callId: "call", name: "tool", type: "tool_call" },
        { callId: " ", input: null, name: "tool", type: "tool_call" },
        { callId: "call", input: null, name: " \t", type: "tool_call" },
        {
          callId: "call",
          isError: "false",
          name: "tool",
          output: null,
          type: "tool_result",
        },
        { data: [256], mediaType: "application/octet-stream", type: "file" },
        { data: [1.5], mediaType: "application/octet-stream", type: "file" },
        {
          data: sparseBytes,
          mediaType: "application/octet-stream",
          type: "file",
        },
        { data: "", filename: 1, mediaType: "text/plain", type: "file" },
        { data: null, name: 1, type: "structured" },
        { providerMetadata: [], text: "text", type: "text" },
        { type: "unknown" },
      ].map((part) => ({ kind: "steer", signal: { parts: [part] } })),
    ];
    for (const [index, payload] of payloads.entries()) {
      binding.dispatchInbound({
        ...payload,
        correlationId: `invalid-${index}`,
        protocolVersion: "1",
        sessionId: binding.sessionId,
      });
    }
    binding.dispatchInbound({
      correlationId: " \t",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: binding.sessionId,
    });
    binding.dispatchInbound({
      correlationId: "first-error",
      kind: "steer",
      protocolVersion: "2",
      sessionId: "wrong",
      signal: { parts: [null] },
    });
    fake.events.end();
    const frames = await collectFrames(outbound, payloads.length + 3);
    expect(frames).toHaveLength(payloads.length + 2);
    expect(frames.map((frame) => rejection(frame).code)).toEqual(
      Array.from({ length: payloads.length + 2 }, () => "session_frame_invalid")
    );
    expect(rejection(frames[payloads.length + 1]).message).toBe(
      'inbound frame protocolVersion must be "1"'
    );
    expect(fake.calls.steer).toEqual([]);
    expect(fake.calls.resolveApproval).toEqual([]);
  });

  test("event failures preserve Error identity and normalize other rejection causes", async () => {
    const error = new Error("event failure");
    const causes = [error, { reason: "event failure" }];
    const outcomes = await Promise.all(
      causes.map(async (cause) => {
        const fake = makeFakeHandle();
        const failure = Promise.withResolvers<never>();
        const handle: ExecutionHandle = {
          ...fake.handle,
          async *events() {
            yield await failure.promise;
          },
        };
        const binding = createDuplexSessionBinding(handle);
        const iterator = binding.outbound()[Symbol.asyncIterator]();
        const pending = iterator.next();
        failure.reject(cause);
        return await rejectionOf(pending);
      })
    );
    expect(outcomes[0]).toBe(error);
    expect(outcomes[1]).toBeInstanceOf(Error);
    expect(outcomes[1]).toMatchObject({
      cause: causes[1],
      message: "duplex session event stream failed",
    });
  });

  test("unknown-callId client_result yields capability_result_stale and resolves nothing", async () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-1",
    });
    const outbound = binding.outbound();

    binding.dispatchInbound({
      correlationId: "corr-1",
      kind: "client_result",
      protocolVersion: "1",
      result: { callId: "unknown-call", content: "x", leaseToken: "lease-1" },
      sessionId: "sess-1",
    });

    const [frame] = await collectFrames(outbound, 1);
    const rej = rejection(frame);
    expect(rej.code).toBe("capability_result_stale");
    expect(rej.correlationId).toBe("corr-1");
  });

  test("approval_response rejected by handle with TuvrenRuntimeError yields session_frame_wrong_state", async () => {
    const fake = makeFakeHandle({
      onResolveApproval: () => {
        throw new TuvrenRuntimeError(
          "resolveApproval() is only valid while execution is paused",
          { code: "invalid_approval_resolution" }
        );
      },
      phase: "paused",
    });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-2",
    });
    const outbound = binding.outbound();

    binding.dispatchInbound({
      correlationId: "corr-2",
      kind: "approval_response",
      protocolVersion: "1",
      response: { decisions: [{ callId: "call-1", type: "approve" }] },
      sessionId: "sess-2",
    });

    fake.events.end();

    const [frame] = await collectFrames(outbound, 1);
    const rej = rejection(frame);
    expect(rej.code).toBe("session_frame_wrong_state");
    expect(rej.correlationId).toBe("corr-2");
    expect(rej.details?.runtimeErrorCode).toBe("invalid_approval_resolution");
  });

  test("approval_response happy path swaps currentHandle and re-bridges replacement events in order", async () => {
    const replacement = makeFakeHandle({ phase: "running" });
    const original = makeFakeHandle({
      onResolveApproval: () => replacement.handle,
      phase: "paused",
    });

    const binding = createDuplexSessionBinding(original.handle, {
      sessionId: "sess-3",
    });
    const outbound = binding.outbound();

    original.events.emit({
      status: "paused",
      timestamp: 0,
      turnId: "turn-3",
      type: "turn.end",
    });
    original.events.end();

    // Drain the original handle's single event before triggering approval.
    const [first] = await collectFrames(outbound, 1);
    expect(first.kind).toBe("event");

    binding.dispatchInbound({
      correlationId: "corr-3",
      kind: "approval_response",
      protocolVersion: "1",
      response: { decisions: [{ callId: "call-1", type: "approve" }] },
      sessionId: "sess-3",
    });

    expect(binding.currentHandle()).toBe(replacement.handle);
    expect(binding.sessionId).toBe("sess-3");

    replacement.events.emit({
      threadId: "thread-3",
      timestamp: 1,
      turnId: "turn-3",
      type: "turn.start",
    });
    replacement.events.emit({
      status: "completed",
      timestamp: 2,
      turnId: "turn-3",
      type: "turn.end",
    });
    replacement.events.end();

    const rest = await collectFrames(outbound, 2);
    expect(
      rest.map((f) => (f.kind === "event" ? f.event.type : f.kind))
    ).toEqual(["turn.start", "turn.end"]);
  });

  test("cancel is passed through to the current handle", () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-4",
    });
    binding.outbound();

    binding.dispatchInbound({
      correlationId: "corr-4",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: "sess-4",
    });

    expect(fake.calls.cancel).toBe(1);
  });

  test("cancel that throws TuvrenRuntimeError yields session_frame_wrong_state", async () => {
    const fake = makeFakeHandle({
      onCancel: () => {
        throw new TuvrenRuntimeError("cancel raced an applied approval", {
          code: "invalid_approval_resolution",
        });
      },
    });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-5",
    });
    const outbound = binding.outbound();

    binding.dispatchInbound({
      correlationId: "corr-5",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: "sess-5",
    });
    fake.events.end();

    const [frame] = await collectFrames(outbound, 1);
    const rej = rejection(frame);
    expect(rej.code).toBe("session_frame_wrong_state");
    expect(rej.details?.runtimeErrorCode).toBe("invalid_approval_resolution");
  });

  test("steer delivers keyed and keyless signals verbatim to the current handle", () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-6",
    });
    binding.outbound();

    const keyedSignal: InputSignal = {
      admissionKey: "  admission-key  ",
      parts: [{ providerMetadata: undefined, text: "hello", type: "text" }],
    };
    const keylessSignal: InputSignal = {
      parts: [{ text: "continue", type: "text" }],
    };

    binding.dispatchInbound({
      correlationId: "corr-6-keyed",
      kind: "steer",
      protocolVersion: "1",
      sessionId: "sess-6",
      signal: keyedSignal,
    });
    binding.dispatchInbound({
      correlationId: "corr-6-keyless",
      kind: "steer",
      protocolVersion: "1",
      sessionId: "sess-6",
      signal: keylessSignal,
    });

    expect(fake.calls.steer).toHaveLength(2);
    expect(fake.calls.steer[0]).toBe(keyedSignal);
    expect(fake.calls.steer[0]?.admissionKey).toBe("  admission-key  ");
    expect(fake.calls.steer[1]).toBe(keylessSignal);
    expect(Object.hasOwn(fake.calls.steer[1] ?? {}, "admissionKey")).toBe(
      false
    );
  });

  test("steer rejects empty and non-string admission keys", async () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-6-invalid-keys",
    });
    const outbound = binding.outbound();

    for (const [index, admissionKey] of ["", 42].entries()) {
      binding.dispatchInbound({
        correlationId: `corr-6-invalid-${index}`,
        kind: "steer",
        protocolVersion: "1",
        sessionId: "sess-6-invalid-keys",
        signal: {
          admissionKey,
          parts: [{ text: "hello", type: "text" }],
        },
      });
    }

    const frames = await collectFrames(outbound, 2);
    expect(frames.map((frame) => rejection(frame).code)).toEqual([
      "session_frame_invalid",
      "session_frame_invalid",
    ]);
    expect(frames.map((frame) => rejection(frame).correlationId)).toEqual([
      "corr-6-invalid-0",
      "corr-6-invalid-1",
    ]);
    expect(fake.calls.steer).toEqual([]);
  });

  test("steer that throws TuvrenRuntimeError yields session_frame_wrong_state", async () => {
    const fake = makeFakeHandle({
      onSteer: () => {
        throw new TuvrenRuntimeError("steer is not valid in this state", {
          code: "invalid_approval_resolution",
        });
      },
    });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-7",
    });
    const outbound = binding.outbound();

    binding.dispatchInbound({
      correlationId: "corr-7",
      kind: "steer",
      protocolVersion: "1",
      sessionId: "sess-7",
      signal: { parts: [{ text: "hi", type: "text" }] },
    });
    fake.events.end();

    const [frame] = await collectFrames(outbound, 1);
    const rej = rejection(frame);
    expect(rej.code).toBe("session_frame_wrong_state");
  });

  test("clientEndpoint.dispatch emits exactly one client_invocation frame and resolves on matching client_result", async () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-8",
    });
    const outbound = binding.outbound();

    const envelope: ClientInvocationEnvelope = {
      callId: "call-42",
      capabilityId: "cap-1",
      input: { foo: "bar" },
      leaseToken: "lease-42",
    };

    let settled: ClientReportedResult | undefined;
    const dispatchPromise = binding.clientEndpoint.dispatch(envelope);
    const observeDispatch = async (): Promise<void> => {
      settled = await dispatchPromise;
    };
    const observation = observeDispatch();

    const [frame] = await collectFrames(outbound, 1);
    expect(frame.kind).toBe("client_invocation");
    if (frame.kind === "client_invocation") {
      expect(frame.invocation).toEqual(envelope);
    }

    // Still pending before the matching client_result arrives.
    await Promise.resolve();
    expect(settled).toBeUndefined();

    const reportedResult: ClientReportedResult = {
      callId: "call-42",
      content: { ok: true },
      leaseToken: "lease-42",
    };

    binding.dispatchInbound({
      correlationId: "corr-8",
      kind: "client_result",
      protocolVersion: "1",
      result: reportedResult,
      sessionId: "sess-8",
    });

    const resolved = await dispatchPromise;
    await observation;
    expect(resolved).toEqual(reportedResult);
  });

  test("malformed frames yield session_frame_invalid and the binding remains functional afterward", async () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-9",
    });
    const outbound = binding.outbound();

    const malformed: unknown[] = [
      "not an object",
      {
        correlationId: "c1",
        kind: "cancel",
        protocolVersion: "2",
        sessionId: "sess-9",
      },
      {
        correlationId: "c2",
        kind: "not_a_kind",
        protocolVersion: "1",
        sessionId: "sess-9",
      },
      {
        correlationId: "c3",
        kind: "cancel",
        protocolVersion: "1",
        sessionId: "wrong-session",
      },
      {
        correlationId: "c4",
        kind: "client_result",
        protocolVersion: "1",
        sessionId: "sess-9",
      },
    ];

    for (const raw of malformed) {
      binding.dispatchInbound(raw);
    }

    const frames = await collectFrames(outbound, malformed.length);
    for (const frame of frames) {
      expect(rejection(frame).code).toBe("session_frame_invalid");
    }
    expect(frames.map((f) => rejection(f).correlationId)).toEqual([
      "unknown",
      "c1",
      "c2",
      "c3",
      "c4",
    ]);

    // Binding is still functional: a subsequent valid frame routes normally.
    binding.dispatchInbound({
      correlationId: "corr-9",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: "sess-9",
    });
    expect(fake.calls.cancel).toBe(1);
  });

  test("outbound() throws when called a second time", () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-10",
    });
    binding.outbound();
    expect(() => binding.outbound()).toThrow();
  });

  test("outbound() closes once the terminal handle's stream ends with no replacement pending", async () => {
    const fake = makeFakeHandle({ phase: "running" });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-11",
    });
    const outbound = binding.outbound();

    fake.setPhase("completed");
    fake.events.end();

    const iterator = outbound[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  test("construction does not consume handle.events(); the first outbound() call does", () => {
    const lazyFake = makeFakeHandle();
    createDuplexSessionBinding(lazyFake.handle, { sessionId: "sess-15" });
    // Still claimable by us: the binding has not touched the stream yet.
    expect(() => lazyFake.events[Symbol.asyncIterator]()).not.toThrow();

    const eagerFake = makeFakeHandle();
    const binding = createDuplexSessionBinding(eagerFake.handle, {
      sessionId: "sess-16",
    });
    binding.outbound();
    // Claimed by the binding's drain the moment outbound() was called.
    expect(() => eagerFake.events[Symbol.asyncIterator]()).toThrow(
      "consumed twice"
    );
  });

  test("whitespace-only correlationId is rejected as session_frame_invalid", async () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-17",
    });
    const outbound = binding.outbound();

    binding.dispatchInbound({
      correlationId: "   ",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: "sess-17",
    });

    const [frame] = await collectFrames(outbound, 1);
    const rej = rejection(frame);
    expect(rej.code).toBe("session_frame_invalid");
    expect(rej.correlationId).toBe("unknown");
    expect(fake.calls.cancel).toBe(0);
  });

  test("dispatch after the session is terminal rejects immediately", async () => {
    const fake = makeFakeHandle({ phase: "running" });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-18",
    });
    const outbound = binding.outbound();

    fake.setPhase("completed");
    fake.events.end();
    const iterator = outbound[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);

    expect(
      await rejectionOf(
        binding.clientEndpoint.dispatch({
          callId: "call-18",
          capabilityId: "cap.demo",
          input: {},
          leaseToken: "lease-18",
        })
      )
    ).toMatchObject({ code: "duplex_session_closed" });
  });

  test("cancel while paused closes the outbound stream and sweeps pending dispatches", async () => {
    const fake = makeFakeHandle({ phase: "paused" });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-19",
    });
    const outbound = binding.outbound();

    const pending = binding.clientEndpoint.dispatch({
      callId: "call-19",
      capabilityId: "cap.demo",
      input: {},
      leaseToken: "lease-19",
    });

    // The runtime closes a paused handle's events stream at the pause; the
    // binding deliberately keeps the outbound queue open awaiting a possible
    // approval_response.
    fake.events.end();

    // A cancel on a paused handle does not throw and surfaces its terminal
    // outcome only through awaitResult(); the binding must still terminate
    // the outbound stream and settle the pending dispatch.
    binding.dispatchInbound({
      correlationId: "corr-19",
      kind: "cancel",
      protocolVersion: "1",
      sessionId: "sess-19",
    });
    expect(fake.calls.cancel).toBe(1);
    fake.settleResult(new Error("execution_cancelled"));

    const iterator = outbound[Symbol.asyncIterator]();
    const drained: unknown[] = [];
    // Drain whatever buffered frames precede the close (the client_invocation
    // frame from the dispatch above).
    for await (const frame of { [Symbol.asyncIterator]: () => iterator }) {
      drained.push(frame);
    }
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ kind: "client_invocation" });

    expect(await rejectionOf(pending)).toMatchObject({
      code: "duplex_session_closed",
    });
  });

  test("a non-TuvrenRuntimeError thrown by the handle propagates out of dispatchInbound", () => {
    const fake = makeFakeHandle({
      onCancel: () => {
        throw new Error("unexpected infrastructure failure");
      },
    });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-12",
    });

    expect(() => {
      binding.dispatchInbound({
        correlationId: "corr-12",
        kind: "cancel",
        protocolVersion: "1",
        sessionId: "sess-12",
      });
    }).toThrow("unexpected infrastructure failure");
  });

  test("terminal close rejects an outstanding client dispatch instead of leaking it", async () => {
    const fake = makeFakeHandle({ phase: "running" });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-13",
    });
    binding.outbound();

    const pending = binding.clientEndpoint.dispatch({
      callId: "call-13",
      capabilityId: "cap.demo",
      input: {},
      leaseToken: "lease-13",
    });

    fake.setPhase("completed");
    fake.events.end();

    expect(await rejectionOf(pending)).toMatchObject({
      code: "duplex_session_closed",
    });
  });

  test("a second dispatch reusing a pending callId is rejected, first dispatch unaffected", async () => {
    const fake = makeFakeHandle({ phase: "running" });
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-14",
    });
    binding.outbound();

    const envelope = {
      callId: "call-14",
      capabilityId: "cap.demo",
      input: {},
      leaseToken: "lease-14",
    };
    const first = binding.clientEndpoint.dispatch(envelope);
    expect(
      await rejectionOf(binding.clientEndpoint.dispatch(envelope))
    ).toMatchObject({
      code: "duplex_session_duplicate_call",
    });

    binding.dispatchInbound({
      correlationId: "corr-14",
      kind: "client_result",
      protocolVersion: "1",
      result: {
        callId: "call-14",
        content: { ok: true },
        leaseToken: "lease-14",
      },
      sessionId: "sess-14",
    });

    const reported = await first;
    expect(reported.content).toEqual({ ok: true });
  });
});
