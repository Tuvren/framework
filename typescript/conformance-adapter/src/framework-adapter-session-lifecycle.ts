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

/**
 * Conformance adapter operations for the ADR-0063 host-session lifecycle:
 * reattach redelivery, grace-window expiry, dispatch timeout, and sequence
 * continuity across attached sinks. These operations drive real runtime turns
 * through the duplex session binding and remote client session.
 */

import { createDuplexSessionBinding } from "@tuvren/host-session";
import type { SessionOutboundFrame } from "@tuvren/host-session";
import { createRemoteClientSession } from "@tuvren/remote-session";
import type {
  RemoteClientSessionSink,
  RemoteSessionClock,
} from "@tuvren/remote-session";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import { decodeResumeCursor } from "@tuvren/stream-core";

import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import {
  createDeferredClientEndpoint,
  createSingleToolCallRunner,
  waitFor,
} from "./framework-adapter-session.ts";
import type { DeferredClientEndpoint } from "./framework-adapter-session.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// ADR-0063 session-lifecycle conformance: reattach redelivery, grace-window
// expiry, dispatch timeout, and sequence continuity across two sinks.
//
// Each operation below drives a REAL `@tuvren/runtime` turn through
// `createDuplexSessionBinding` + `@tuvren/remote-session`'s
// `createRemoteClientSession`, using the same `createDeferredClientEndpoint`
// helper the rest of this file's host-session operations use. Where a check
// needs deterministic timer control (grace-window expiry, dispatch timeout)
// it supplies a small fake `RemoteSessionClock` — the in-process adapter
// equivalent of `typescript/host/remote-session/test/remote-client-session.test.ts`'s
// own `createFakeClock`, kept local here since adapters may not import
// another package's test sources.
//
// Adapter rules: no assertion logic, no pass/fail grading. Raw observational
// data only; booleans computed here (e.g. "do these two invocations carry the
// same idempotencyKey") are the same kind of adapter-local arithmetic the
// event-stream-ws adapter already performs over its own captured cursors.
// ---------------------------------------------------------------------------

interface RecordedSessionFrame {
  cursor: string | undefined;
  frame: SessionOutboundFrame;
}

const SESSION_LIFECYCLE_REPLAY_CAPACITY = 200;

// ---------------------------------------------------------------------------
// Operation: host-session.reattach-redelivery
//
// ADR-0063 decision 3: an unanswered client_invocation is redelivered to the
// next attached sink after a detach, with its original callId, leaseToken,
// and idempotencyKey preserved (redelivery is safe because the correlation
// handles already in the wire vocabulary make it safe, not because of a new
// delivery-guarantee layer). session_rejection frames are never redelivered.
// ---------------------------------------------------------------------------

const REATTACH_SESSION_ID = "sess-host-session-reattach-1";
const REATTACH_CAP = "session.reattach.echo";
const REATTACH_CALL_ID = "reattach-call-1";

// ---------------------------------------------------------------------------
// Operation: host-session.grace-window-expiry
//
// ADR-0063 decision 4: detach starts a disconnectGraceMs timer instead of
// failing in-flight dispatches immediately; expiry settles every pending
// dispatch with capability_binding_unavailable and permanently ends the
// session. Verified against the persisted kernel record read back after the
// turn completes, not against an in-flight event capture.
// ---------------------------------------------------------------------------

const GRACE_SESSION_ID = "sess-host-session-grace-1";
const GRACE_CAP = "session.grace.echo";
const GRACE_CALL_ID = "grace-call-1";

// ---------------------------------------------------------------------------
// Operation: host-session.dispatch-timeout
//
// ADR-0063 decision 5: the dispatch clock measures peer responsiveness only,
// so it is suspended while detached and restarted (full budget) for any
// invocation redelivered on reattach. Timer-pending counts observed at each
// step mirror `remote-client-session.test.ts`'s own dispatch-timeout test;
// the terminal outcome is verified against the persisted kernel record.
// ---------------------------------------------------------------------------

const TIMEOUT_SESSION_ID = "sess-host-session-dispatch-timeout-1";
const TIMEOUT_CAP = "session.dispatch-timeout.echo";
const TIMEOUT_CALL_ID = "dispatch-timeout-call-1";

// ---------------------------------------------------------------------------
// Operation: host-session.sequence-continuity
//
// ADR-0063 decision 2: one sequencer, one replay buffer, for the session's
// whole life, so sequence numbering never restarts across a reattach and a
// replay window is never fed by two independent numberings. Mirrors the
// event-stream-ws adapter's `reconnect-with-cursor` operation (same
// arithmetic-progression technique for asserting gaplessness without racing
// the turn's own pace) but exercises `@tuvren/remote-session` directly,
// beneath any transport.
// ---------------------------------------------------------------------------

const SEQCONT_SESSION_ID = "sess-host-session-seqcontinuity-1";
const SEQCONT_CAP = "session.seq-continuity.echo";
const SEQCONT_CALL_ID = "seq-continuity-call-1";

const createRecordingSessionSink = (): RemoteClientSessionSink & {
  sent: RecordedSessionFrame[];
} => {
  const sent: RecordedSessionFrame[] = [];
  return {
    send(frame: SessionOutboundFrame, cursor?: string): void {
      sent.push({ cursor, frame });
    },
    sent,
  };
};

const sentFramesOfKind = <Kind extends SessionOutboundFrame["kind"]>(
  sent: readonly RecordedSessionFrame[],
  kind: Kind
): Extract<SessionOutboundFrame, { kind: Kind }>[] =>
  sent
    .map((entry) => entry.frame)
    .filter(
      (frame): frame is Extract<SessionOutboundFrame, { kind: Kind }> =>
        frame.kind === kind
    );

/**
 * A deterministic, test-controlled `RemoteSessionClock`: timers only fire
 * when the adapter explicitly calls {@link fireOldest}. Mirrors
 * `@tuvren/remote-session`'s own test fake; kept local since adapters do not
 * import another package's test sources.
 *
 * `pendingCount()` alone cannot distinguish a pending dispatch timer from a
 * pending grace timer — both are just "one scheduled timeout" to a plain
 * count, and `RemoteClientSession` schedules both kinds through this same
 * clock at different points in its lifecycle (dispatch timers at
 * `dispatchTimeoutMs`, the grace timer at `disconnectGraceMs`). This fake
 * therefore also records each timer's requested duration, so
 * {@link pendingCountWithMs} can answer "how many pending timers were
 * scheduled for exactly this many milliseconds" — letting a check assert
 * WHICH timer is pending, not merely how many timers are pending, as long as
 * the two durations configured for a given scenario are distinct (which
 * every conformance scenario using this fake deliberately arranges).
 */
const createFakeSessionClock = (): {
  clock: RemoteSessionClock;
  fireOldest: () => void;
  pendingCount: () => number;
  pendingCountWithMs: (ms: number) => number;
} => {
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; ms: number }>();

  const clock: RemoteSessionClock = {
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") {
        timers.delete(handle);
      }
    },
    scheduleTimeout(callback: () => void, ms: number): unknown {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
  };

  return {
    clock,
    fireOldest(): void {
      const [id] = [...timers.keys()].toSorted((a, b) => a - b);
      if (id === undefined) {
        throw new Error("createFakeSessionClock.fireOldest: no pending timer");
      }
      const timer = timers.get(id);
      timers.delete(id);
      timer?.callback();
    },
    pendingCount(): number {
      return timers.size;
    },
    pendingCountWithMs(ms: number): number {
      return [...timers.values()].filter((timer) => timer.ms === ms).length;
    },
  };
};

/** Reads back the durably staged `tool_result` part matching `callId` from a branch's persisted messages, mirroring the shape `tool.result` events carry (`isError`, `output`). */
const findPersistedToolResultOutput = (
  messages: readonly unknown[],
  callId: string
): { isError: boolean; output: unknown } | undefined => {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") {
      continue;
    }
    const { parts } = message;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (
        isRecord(part) &&
        part.type === "tool_result" &&
        part.callId === callId
      ) {
        return { isError: part.isError === true, output: part.output };
      }
    }
  }
  return undefined;
};

const toolResultOutputCode = (output: unknown): string | undefined =>
  isRecord(output) && typeof output.code === "string" ? output.code : undefined;

export const runReattachRedelivery = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    REATTACH_CAP,
    REATTACH_CALL_ID,
    "host-session reattach-redelivery conformance complete"
  );
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const deferredEndpoint: DeferredClientEndpoint = createDeferredClientEndpoint(
    "ep-reattach",
    [
      {
        capabilityId: REATTACH_CAP,
        description:
          "host-session reattach-redelivery conformance echo capability",
        inputSchema: { type: "object" },
      },
    ]
  );
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [deferredEndpoint], name: AGENT_NAME },
    signal: textSignal("host-session reattach redelivery conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: REATTACH_SESSION_ID,
  });
  deferredEndpoint.setDelegate(binding.clientEndpoint);

  const session = createRemoteClientSession({
    binding,
    disconnectGraceMs: 30_000,
    dispatchTimeoutMs: 30_000,
    replayBufferCapacity: SESSION_LIFECYCLE_REPLAY_CAPACITY,
  });

  const sink1 = createRecordingSessionSink();
  session.attach(sink1);
  await waitFor(
    () => sentFramesOfKind(sink1.sent, "client_invocation").length > 0
  );
  const firstInvocation = sentFramesOfKind(sink1.sent, "client_invocation")[0]
    ?.invocation;

  // Simulate a dropped link: detach without ever answering the call.
  session.detach();

  const sink2 = createRecordingSessionSink();
  session.attach(sink2);
  await waitFor(
    () => sentFramesOfKind(sink2.sent, "client_invocation").length > 0
  );
  const secondInvocation = sentFramesOfKind(sink2.sent, "client_invocation")[0]
    ?.invocation;

  session.dispatchInbound({
    correlationId: "corr-reattach-accept-1",
    kind: "client_result",
    protocolVersion: "1",
    result: {
      callId: secondInvocation.callId,
      content: { accepted: true },
      leaseToken: secondInvocation.leaseToken,
    },
    sessionId: REATTACH_SESSION_ID,
  });

  const result = await handle.awaitResult();

  const observation = {
    finalStatus: result.status,
    firstInvocation: {
      callId: firstInvocation.callId,
      idempotencyKey: firstInvocation.idempotencyKey ?? null,
      leaseToken: firstInvocation.leaseToken,
    },
    idempotencyKeyPresent:
      typeof firstInvocation.idempotencyKey === "string" &&
      firstInvocation.idempotencyKey.length > 0,
    redeliveredInvocationCount: sentFramesOfKind(
      sink2.sent,
      "client_invocation"
    ).length,
    sameCallId: firstInvocation.callId === secondInvocation.callId,
    sameIdempotencyKey:
      firstInvocation.idempotencyKey === secondInvocation.idempotencyKey,
    sameLeaseToken: firstInvocation.leaseToken === secondInvocation.leaseToken,
    secondInvocation: {
      callId: secondInvocation.callId,
      idempotencyKey: secondInvocation.idempotencyKey ?? null,
      leaseToken: secondInvocation.leaseToken,
    },
    sessionRejectionRedeliveredCount: sentFramesOfKind(
      sink2.sent,
      "session_rejection"
    ).length,
  };

  return { evidence: observation, result: observation };
};

export const runGraceWindowExpiry = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    GRACE_CAP,
    GRACE_CALL_ID,
    "host-session grace-window-expiry conformance complete"
  );
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const deferredEndpoint = createDeferredClientEndpoint("ep-grace", [
    {
      capabilityId: GRACE_CAP,
      description:
        "host-session grace-window-expiry conformance echo capability",
      inputSchema: { type: "object" },
    },
  ]);
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [deferredEndpoint], name: AGENT_NAME },
    signal: textSignal("host-session grace window expiry conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: GRACE_SESSION_ID,
  });
  deferredEndpoint.setDelegate(binding.clientEndpoint);

  const fakeClock = createFakeSessionClock();
  const session = createRemoteClientSession({
    binding,
    clock: fakeClock.clock,
    disconnectGraceMs: 1000,
    dispatchTimeoutMs: 60_000,
    replayBufferCapacity: SESSION_LIFECYCLE_REPLAY_CAPACITY,
  });

  const sink1 = createRecordingSessionSink();
  session.attach(sink1);
  await waitFor(
    () => sentFramesOfKind(sink1.sent, "client_invocation").length > 0
  );

  // `pendingTimersBeforeDetach`/`pendingTimersAfterDetach` are corroboration,
  // not proof on their own: a bare count of 1 is consistent with either "the
  // dispatch timer is still running" or "the grace timer just replaced it",
  // and this scenario's real semantic claim — that detach suspends the
  // dispatch timer and starts a distinct grace timer instead of leaving the
  // dispatch timer running — is what `pendingGraceTimerAfterDetach` (below)
  // and the persisted `capability_binding_unavailable` result actually
  // prove.
  const pendingTimersBeforeDetach = fakeClock.pendingCount();
  session.detach();
  const pendingTimersAfterDetach = fakeClock.pendingCount();
  // Distinguishes the grace timer (scheduled for `disconnectGraceMs`) from a
  // same-count dispatch timer: proves the timer pending immediately after
  // detach is specifically the grace timer, not a dispatch timer that failed
  // to suspend.
  const pendingGraceTimerAfterDetach = fakeClock.pendingCountWithMs(1000);
  fakeClock.fireOldest();

  const result = await handle.awaitResult();
  const persistedMessages = await harness.readBranchMessages(thread.branchId);
  const persistedToolResult = findPersistedToolResultOutput(
    persistedMessages,
    GRACE_CALL_ID
  );

  const observation = {
    finalStatus: result.status,
    pendingGraceTimerAfterDetach,
    pendingTimersAfterDetach,
    pendingTimersBeforeDetach,
    persistedToolResultOutputCode:
      toolResultOutputCode(persistedToolResult?.output) ?? null,
    sessionEnded: session.isEnded(),
  };

  return { evidence: observation, result: observation };
};

export const runDispatchTimeout = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    TIMEOUT_CAP,
    TIMEOUT_CALL_ID,
    "host-session dispatch-timeout conformance complete"
  );
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const deferredEndpoint = createDeferredClientEndpoint("ep-dispatch-timeout", [
    {
      capabilityId: TIMEOUT_CAP,
      description: "host-session dispatch-timeout conformance echo capability",
      inputSchema: { type: "object" },
    },
  ]);
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [deferredEndpoint], name: AGENT_NAME },
    signal: textSignal("host-session dispatch timeout conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: TIMEOUT_SESSION_ID,
  });
  deferredEndpoint.setDelegate(binding.clientEndpoint);

  const fakeClock = createFakeSessionClock();
  const session = createRemoteClientSession({
    binding,
    clock: fakeClock.clock,
    disconnectGraceMs: 100_000,
    dispatchTimeoutMs: 500,
    replayBufferCapacity: SESSION_LIFECYCLE_REPLAY_CAPACITY,
  });

  const sink1 = createRecordingSessionSink();
  session.attach(sink1);
  await waitFor(
    () => sentFramesOfKind(sink1.sent, "client_invocation").length > 0
  );
  // `pendingTimersWhileAttached`/`pendingTimersAfterDetach`/
  // `pendingTimersAfterReattach` are corroboration, not proof: a bare count
  // of 1 at every step is equally consistent with "the same dispatch timer
  // never stopped" as with "a dispatch timer was suspended and a distinct
  // grace timer took its place, then a fresh dispatch timer was armed on
  // reattach" — the two scenarios this check exists to distinguish. This
  // scenario deliberately configures `dispatchTimeoutMs: 500` and
  // `disconnectGraceMs: 100_000` (two very different durations) so
  // `pendingCountWithMs` can tell them apart: `pendingDispatchTimer*` fields
  // below are the actual semantic proof, alongside the persisted
  // `capability_dispatch_timeout` result and `redeliveredInvocationCount`.
  const pendingTimersWhileAttached = fakeClock.pendingCount();
  const pendingDispatchTimerWhileAttached = fakeClock.pendingCountWithMs(500);

  session.detach();
  const pendingTimersAfterDetach = fakeClock.pendingCount();
  // Proves the dispatch timer was actually suspended on detach (ADR-0063
  // decision 5), not merely that some timer count stayed steady — the
  // pending set right after detach must contain zero timers scheduled for
  // the dispatch duration.
  const pendingDispatchTimerAfterDetach = fakeClock.pendingCountWithMs(500);

  const sink2 = createRecordingSessionSink();
  session.attach(sink2);
  const pendingTimersAfterReattach = fakeClock.pendingCount();
  // Proves the timer pending after reattach is a freshly re-armed dispatch
  // timer with the full budget, not a leftover grace timer or a stale
  // dispatch timer that survived detach.
  const pendingDispatchTimerAfterReattach = fakeClock.pendingCountWithMs(500);
  const redeliveredInvocationCount = sentFramesOfKind(
    sink2.sent,
    "client_invocation"
  ).length;

  fakeClock.fireOldest();

  const result = await handle.awaitResult();
  const persistedMessages = await harness.readBranchMessages(thread.branchId);
  const persistedToolResult = findPersistedToolResultOutput(
    persistedMessages,
    TIMEOUT_CALL_ID
  );

  const observation = {
    finalStatus: result.status,
    pendingDispatchTimerAfterDetach,
    pendingDispatchTimerAfterReattach,
    pendingDispatchTimerWhileAttached,
    pendingTimersAfterDetach,
    pendingTimersAfterReattach,
    pendingTimersWhileAttached,
    persistedToolResultOutputCode:
      toolResultOutputCode(persistedToolResult?.output) ?? null,
    redeliveredInvocationCount,
  };

  return { evidence: observation, result: observation };
};

export const runSequenceContinuity = async (): Promise<AdapterProjection> => {
  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    SEQCONT_CAP,
    SEQCONT_CALL_ID,
    "host-session sequence-continuity conformance complete"
  );
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const deferredEndpoint = createDeferredClientEndpoint("ep-seqcontinuity", [
    {
      capabilityId: SEQCONT_CAP,
      description:
        "host-session sequence-continuity conformance echo capability",
      inputSchema: { type: "object" },
    },
  ]);
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [deferredEndpoint], name: AGENT_NAME },
    signal: textSignal("host-session sequence continuity conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: SEQCONT_SESSION_ID,
  });
  deferredEndpoint.setDelegate(binding.clientEndpoint);

  const session = createRemoteClientSession({
    binding,
    disconnectGraceMs: 30_000,
    dispatchTimeoutMs: 30_000,
    replayBufferCapacity: SESSION_LIFECYCLE_REPLAY_CAPACITY,
  });

  const sink1 = createRecordingSessionSink();
  session.attach(sink1);

  // Pacing is structural, not incidental: the client_result is deliberately
  // NOT submitted until after the reattach below, so the turn cannot finish
  // (and the binding cannot go terminal) at any point during the
  // detach/reattach window — the unanswered tuvren-client call holds it
  // open under the generous 30s budgets above. Waiting for two cursor-bearing
  // event frames (turn.start plus at least one more precedes any tool
  // resolution) guarantees the replay from the FIRST event's cursor is
  // non-empty by construction, so the plan's replayObservedAtLeastOneEvent
  // assertion cannot fail on turn pacing.
  await waitFor(
    () =>
      sentFramesOfKind(sink1.sent, "client_invocation").length > 0 &&
      sink1.sent.filter(
        (entry) =>
          entry.frame.kind === "event" && typeof entry.cursor === "string"
      ).length >= 2
  );
  const invocation = sentFramesOfKind(sink1.sent, "client_invocation")[0]
    ?.invocation;
  const firstEventFrameBeforeDetach = sink1.sent.find(
    (entry): entry is RecordedSessionFrame & { cursor: string } =>
      entry.frame.kind === "event" && typeof entry.cursor === "string"
  );
  const cursorAtFirstEvent = firstEventFrameBeforeDetach?.cursor;
  const sequenceAtFirstEvent =
    cursorAtFirstEvent === undefined
      ? undefined
      : decodeResumeCursor(cursorAtFirstEvent)?.sequence;

  // Simulated drop, not session.close(): detaches this sink without ending
  // the still-running turn (ADR-0063 decision 4). The pump keeps recording
  // further sequenced events into the shared replay buffer regardless of
  // attachment.
  session.detach();

  const sink2 = createRecordingSessionSink();
  const { resumeStatus } =
    cursorAtFirstEvent === undefined
      ? session.attach(sink2)
      : session.attach(sink2, { cursor: cursorAtFirstEvent });

  // Only now — with sink2 attached (inbound routing requires an attached
  // sink) and the replay already delivered — is the invocation answered,
  // releasing the turn to run to completion.
  session.dispatchInbound({
    correlationId: "corr-seqcontinuity-accept-1",
    kind: "client_result",
    protocolVersion: "1",
    result: {
      callId: invocation.callId,
      content: { accepted: true },
      leaseToken: invocation.leaseToken,
    },
    sessionId: SEQCONT_SESSION_ID,
  });

  // The turn finishes on its own schedule; wait for the session to end
  // naturally (the underlying binding's outbound stream reaching terminal)
  // rather than racing it with an external awaitResult(), mirroring the
  // event-stream-ws adapter's own reconnect operation.
  await waitFor(() => session.isEnded(), 10_000);

  const replayedSequences = sink2.sent
    .filter((entry) => entry.frame.kind === "event")
    .map((entry) =>
      entry.cursor === undefined
        ? null
        : (decodeResumeCursor(entry.cursor)?.sequence ?? null)
    );
  const expectedReplaySequences =
    sequenceAtFirstEvent === undefined
      ? []
      : replayedSequences.map((_, index) => sequenceAtFirstEvent + 1 + index);

  const observation = {
    expectedReplaySequences,
    lastSequenceBeforeDetach: sequenceAtFirstEvent ?? null,
    noSequenceRestart: replayedSequences.every(
      (sequence) =>
        sequence !== null &&
        sequence > (sequenceAtFirstEvent ?? Number.NEGATIVE_INFINITY)
    ),
    replayGaplessAndContiguous:
      JSON.stringify(replayedSequences) ===
      JSON.stringify(expectedReplaySequences),
    // Guards the vacuous-empty case: expectedReplaySequences is derived from
    // replayedSequences' own length, so with zero replayed events both the
    // gapless and no-restart comparisons would be trivially true. A resumed
    // reattach in this scenario must actually replay the events recorded
    // while detached; a plan assertion requires this to be true.
    replayObservedAtLeastOneEvent: replayedSequences.length > 0,
    replayedSequences,
    resumeStatus,
  };

  return { evidence: observation, result: observation };
};
