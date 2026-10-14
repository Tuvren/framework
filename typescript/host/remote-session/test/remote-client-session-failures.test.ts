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

import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type { ExecutionHandle, ExecutionResult } from "@tuvren/core/execution";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import type {
  DuplexSessionBinding,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import type { StreamAdapterWarning } from "@tuvren/stream-core";

import { createRemoteClientSession } from "../src/lib/remote-client-session.ts";
import type {
  RemoteClientSessionOptions,
  RemoteClientSessionSink,
  RemoteSessionClock,
} from "../src/lib/remote-client-session.ts";

const makeFakeHandle = (): { handle: ExecutionHandle } => {
  const result = Promise.withResolvers<ExecutionResult>();
  const event = Promise.withResolvers<IteratorResult<TuvrenStreamEvent>>();
  const handle: ExecutionHandle = {
    awaitResult: async () => await result.promise,
    cancel: () => {
      throw new Error("control not used");
    },
    events: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => await event.promise }),
    }),
    resolveApproval: () => {
      throw new Error("control not used");
    },
    status: () => ({ iterationCount: 0, phase: "running" }),
    steer: () => {
      throw new Error("control not used");
    },
  };
  return { handle };
};
interface SentFrame {
  cursor: string | undefined;
  frame: SessionOutboundFrame;
}

const createFakeSink = (): RemoteClientSessionSink & { sent: SentFrame[] } => {
  const sent: SentFrame[] = [];
  return {
    send(frame: SessionOutboundFrame, cursor?: string): void {
      sent.push({ cursor, frame });
    },
    sent,
  };
};

/** A deterministic, test-controlled substitute for {@link RemoteSessionClock}: timers only fire when the test explicitly calls {@link fireOldest}. */
const createFakeClock = (): {
  clock: RemoteSessionClock;
  fireOldest: () => void;
  pendingCount: () => number;
} => {
  let nextId = 0;
  const timers = new Map<number, () => void>();

  const clock: RemoteSessionClock = {
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") {
        timers.delete(handle);
      }
    },
    scheduleTimeout(callback: () => void, _ms: number): unknown {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
  };

  return {
    clock,
    fireOldest(): void {
      const [id] = [...timers.keys()].toSorted((a, b) => a - b);
      if (id === undefined) {
        throw new Error("createFakeClock.fireOldest: no pending timer");
      }
      const timer = timers.get(id);
      timers.delete(id);
      timer?.();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
};

/** Drains pending microtask continuations of the session's internal pump loop without any real (wall-clock) wait. */
const flush = async (times = 8): Promise<void> => {
  if (times === 0) {
    return;
  }
  await Promise.resolve();
  await flush(times - 1);
};

const setup = (overrides: Partial<RemoteClientSessionOptions> = {}) => {
  const { handle } = makeFakeHandle();
  const binding = createDuplexSessionBinding(handle, {
    sessionId: "sess-remote-1",
  });
  const fakeClock = createFakeClock();
  const warnings: StreamAdapterWarning[] = [];

  const session = createRemoteClientSession({
    binding,
    clock: fakeClock.clock,
    disconnectGraceMs: 1000,
    dispatchTimeoutMs: 500,
    onWarning: (warning) => {
      warnings.push(warning);
    },
    replayBufferCapacity: 50,
    ...overrides,
  });

  return { binding, fakeClock, session, warnings };
};

describe("remote session rejection boundaries", () => {
  test("invalid isError leaves dispatch owed until redelivery and a valid result settles", async () => {
    const { binding, fakeClock, session } = setup();
    const sink = createFakeSink();
    session.attach(sink);
    const invocation = {
      callId: "call-is-error",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "lease-is-error",
    };
    const dispatch = binding.clientEndpoint.dispatch(invocation);
    await flush();
    const malformed = {
      correlationId: "invalid-is-error",
      kind: "client_result",
      protocolVersion: "1",
      result: {
        callId: invocation.callId,
        content: { ok: true },
        isError: "false",
        leaseToken: invocation.leaseToken,
      },
      sessionId: session.sessionId,
    };
    session.dispatchInbound(malformed);
    await flush();
    expect(sink.sent.map((item) => item.frame.kind)).toEqual([
      "client_invocation",
      "session_rejection",
    ]);
    expect(sink.sent[1]?.frame).toMatchObject({
      rejection: {
        code: "session_frame_invalid",
        correlationId: "invalid-is-error",
      },
    });
    expect(fakeClock.pendingCount()).toBe(1);
    session.detach();
    const reattached = createFakeSink();
    session.attach(reattached);
    expect(reattached.sent).toHaveLength(1);
    expect(reattached.sent[0]?.frame).toMatchObject({ invocation });
    const result = { ...malformed.result, isError: false };
    session.dispatchInbound({
      ...malformed,
      correlationId: "valid-is-error",
      result,
    });
    expect(await dispatch).toBe(result);
    expect(fakeClock.pendingCount()).toBe(0);
    session.detach();
    const third = createFakeSink();
    session.attach(third);
    expect(third.sent).toEqual([]);
    session.close();
  });

  test("throwing sink settles pending calls before releasing outbound and never pulls again", async () => {
    const { handle } = makeFakeHandle();
    const real = createDuplexSessionBinding(handle, {
      sessionId: "sink-failure",
    });
    let reads = 0;
    let returns = 0;
    const binding: DuplexSessionBinding = {
      ...real,
      outbound: () => {
        const iterator = real.outbound()[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              reads += 1;
              return await iterator.next();
            },
            return: async () => {
              returns += 1;
              if (iterator.return === undefined) {
                throw new Error("missing iterator return");
              }
              return await iterator.return();
            },
          }),
        };
      },
    };
    const warnings: StreamAdapterWarning[] = [];
    const fakeClock = createFakeClock();
    const session = createRemoteClientSession({
      binding,
      clock: fakeClock.clock,
      disconnectGraceMs: 1000,
      dispatchTimeoutMs: 500,
      onWarning: (warning) => {
        warnings.push(warning);
      },
      replayBufferCapacity: 10,
    });
    session.attach({
      send: () => {
        throw new Error("sink broke");
      },
    });
    const dispatch = binding.clientEndpoint.dispatch({
      callId: "sink-call",
      capabilityId: "cap-1",
      input: {},
      leaseToken: "sink-lease",
    });
    await flush();
    expect(await dispatch).toMatchObject({
      content: {
        code: "capability_binding_unavailable",
        error: "the session's outbound pump failed",
      },
      isError: true,
    });
    expect(warnings).toMatchObject([
      {
        code: "remote_session_outbound_pump_failed",
        message: "the session's outbound pump failed: sink broke",
      },
    ]);
    expect(session.isEnded()).toBe(true);
    expect(fakeClock.pendingCount()).toBe(0);
    expect(reads).toBe(1);
    expect(returns).toBe(1);
    await flush();
    expect(reads).toBe(1);
  });
});
