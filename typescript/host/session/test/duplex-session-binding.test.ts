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
import type {
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  InputSignal,
} from "@tuvren/core/execution";
import type { ApprovalResponse } from "@tuvren/core/tools";
import { createDuplexSessionBinding } from "../src/lib/duplex-session-binding.ts";
import type {
  SessionOutboundFrame,
  SessionRejectionFrame,
} from "../src/lib/session-frame-shapes.ts";

// ---------------------------------------------------------------------------
// Fake ExecutionHandle double
// ---------------------------------------------------------------------------

interface FakeStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** A controllable single-consumer async event source for the fake handle. */
class FakeEventSource implements AsyncIterable<FakeStreamEvent> {
  private readonly items: FakeStreamEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<FakeStreamEvent>) => void
  > = [];
  private closed = false;
  private claimed = false;

  push(event: FakeStreamEvent): void {
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

  [Symbol.asyncIterator](): AsyncIterator<FakeStreamEvent> {
    if (this.claimed) {
      throw new Error("FakeEventSource consumed twice");
    }
    this.claimed = true;
    return {
      next: (): Promise<IteratorResult<FakeStreamEvent>> => {
        const value = this.items.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
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
  setPhase(phase: ExecutionStatus["phase"]): void;
}

function makeFakeHandle(
  options: {
    phase?: ExecutionStatus["phase"];
    onResolveApproval?: (response: ApprovalResponse) => ExecutionHandle;
    onSteer?: (signal: InputSignal) => void;
    onCancel?: () => void;
  } = {}
): FakeHandle {
  const events = new FakeEventSource();
  const calls: FakeHandleCalls = { cancel: 0, resolveApproval: [], steer: [] };
  let phase: ExecutionStatus["phase"] = options.phase ?? "running";

  const handle: ExecutionHandle = {
    awaitResult(): Promise<ExecutionResult> {
      throw new Error("not used in these tests");
    },
    cancel(): void {
      calls.cancel += 1;
      if (options.onCancel !== undefined) {
        options.onCancel();
      }
    },
    events(): AsyncIterable<FakeStreamEvent> {
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
  } as unknown as ExecutionHandle;

  return {
    calls,
    events,
    handle,
    setPhase(nextPhase: ExecutionStatus["phase"]): void {
      phase = nextPhase;
    },
  };
}

async function collectFrames(
  iterable: AsyncIterable<SessionOutboundFrame>,
  count: number
): Promise<SessionOutboundFrame[]> {
  const collected: SessionOutboundFrame[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  while (collected.length < count) {
    const result = await iterator.next();
    if (result.done) {
      break;
    }
    collected.push(result.value);
  }
  return collected;
}

function rejection(
  frame: SessionOutboundFrame
): SessionRejectionFrame["rejection"] {
  if (frame.kind !== "session_rejection") {
    throw new Error(`expected session_rejection frame, got "${frame.kind}"`);
  }
  return frame.rejection;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDuplexSessionBinding", () => {
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

    original.events.push({ type: "turn.paused" });
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

    replacement.events.push({ type: "turn.resumed" });
    replacement.events.push({ type: "turn.completed" });
    replacement.events.end();

    const rest = await collectFrames(outbound, 2);
    expect(
      rest.map((f) => String(f.kind === "event" ? f.event.type : f.kind))
    ).toEqual(["turn.resumed", "turn.completed"]);
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

  test("steer delivers the signal verbatim to the current handle", () => {
    const fake = makeFakeHandle();
    const binding = createDuplexSessionBinding(fake.handle, {
      sessionId: "sess-6",
    });
    binding.outbound();

    const signal: InputSignal = {
      parts: [{ providerMetadata: undefined, text: "hello", type: "text" }],
    } as InputSignal;

    binding.dispatchInbound({
      correlationId: "corr-6",
      kind: "steer",
      protocolVersion: "1",
      sessionId: "sess-6",
      signal,
    });

    expect(fake.calls.steer).toHaveLength(1);
    expect(fake.calls.steer[0]).toEqual(signal);
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
    dispatchPromise.then((result) => {
      settled = result;
    });

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
});
