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
 * Conformance adapter operations for the `tuvren.framework.host-session`
 * duplex session frame vocabulary (issue #99, ADR-0060). Each operation
 * drives a real `@tuvren/runtime` turn through `createDuplexSessionBinding`
 * (`@tuvren/host-session`) and returns structured evidence that the shared
 * certification harness asserts against `host-session.json`'s checks.
 *
 * Adapter rules: no assertion logic, no pass/fail grading, no evidence
 * field names that imply semantic verdicts. Raw observational data only.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  AttachedClientEndpoint,
  ClientEndpointCapabilityAdvertisement,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
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
import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const HOST_SESSION_JSON_SCHEMA_DIR = path.resolve(
  REPO_ROOT,
  "spec/host/session/artifacts/json-schema"
);
const SESSION_INBOUND_FRAME_ID =
  "https://tuvren.dev/schemas/framework/host-session/SessionInboundFrame.json";
const SESSION_OUTBOUND_FRAME_ID =
  "https://tuvren.dev/schemas/framework/host-session/SessionOutboundFrame.json";

const fromSynchronous = <Argument, Value>(
  operation: (argument: Argument) => Value
): ((argument: Argument) => Promise<Value>) =>
  Promise.try.bind<
    typeof Promise,
    [(argument: Argument) => Value],
    [Argument],
    Promise<Value>
  >(Promise, operation);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Shared runtime-wiring helpers
// ---------------------------------------------------------------------------

/**
 * `runtime.executeTurn()` reads `config.clientEndpoints` synchronously and
 * returns the `ExecutionHandle` `createDuplexSessionBinding` needs as its
 * first argument — so the real `AttachedClientEndpoint` the binding owns
 * cannot exist yet at the point `executeTurn` is called. This deferred
 * endpoint breaks that cycle: it is handed to `executeTurn` up front, and
 * `setDelegate` wires it to `binding.clientEndpoint` immediately afterward,
 * in the same synchronous tick. The runtime never starts pulling the
 * runner's iterations (and therefore never dispatches a tool call) until
 * something consumes the event stream (see
 * `typescript/runtime/test/runtime-core.execution-lifecycle.test.ts`
 * "does not start execution until the event stream is consumed"), and
 * `createDuplexSessionBinding`'s internal drain only begins pulling on the
 * next microtask — so `setDelegate` always lands before `dispatch` can ever
 * be called.
 */
interface DeferredClientEndpoint extends AttachedClientEndpoint {
  setDelegate: (delegate: AttachedClientEndpoint) => void;
}

// ---------------------------------------------------------------------------
// Operation: host-session.validate-frame-fixtures
//
// Fixture-driven: validates every committed host-session frame fixture
// against the generated SessionInboundFrame / SessionOutboundFrame JSON
// Schema artifacts, resolving local sibling $refs. Mirrors the Ajv 2020-12
// setup in tools/scripts/authority-packet/validate-authority-packets.ts.
// ---------------------------------------------------------------------------

interface HostSessionFrameValidators {
  inbound: ValidateFunction;
  outbound: ValidateFunction;
}

let validatorsPromise: Promise<HostSessionFrameValidators> | undefined;

interface HostSessionFrameFixture {
  direction: "inbound" | "outbound";
  expectedValid: boolean;
  frame: unknown;
  name: string;
}

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

const createDeferredClientEndpoint = (
  endpointId: string,
  advertisedCapabilities: ClientEndpointCapabilityAdvertisement[]
): DeferredClientEndpoint => {
  let delegate: AttachedClientEndpoint | undefined;

  return {
    advertisedCapabilities,
    async dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      if (delegate === undefined) {
        throw new Error(
          "host-session conformance adapter dispatched a client invocation before the duplex session binding was wired"
        );
      }
      return await delegate.dispatch(envelope);
    },
    endpointId,
    setDelegate(nextDelegate: AttachedClientEndpoint): void {
      delegate = nextDelegate;
    },
  };
};

const waitForAbort = async (signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined || signal.aborted) {
    return;
  }

  const aborted = Promise.withResolvers<undefined>();
  signal.addEventListener(
    "abort",
    () => {
      aborted.resolve();
    },
    { once: true }
  );
  await aborted.promise;
};

const waitForUntil = async (
  predicate: () => boolean,
  deadline: number
): Promise<void> => {
  if (predicate()) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error("host-session conformance adapter waitFor timed out");
  }

  await delay(5);
  await waitForUntil(predicate, deadline);
};

export const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> => {
  await waitForUntil(predicate, Date.now() + timeoutMs);
};

const drainFrames = async (
  iterator: AsyncIterator<SessionOutboundFrame>,
  sink: SessionOutboundFrame[]
): Promise<void> => {
  const step = await iterator.next();
  if (step.done === true) {
    return;
  }
  sink.push(step.value);
  await drainFrames(iterator, sink);
};

const isFrameOfKind = <Kind extends SessionOutboundFrame["kind"]>(
  frame: SessionOutboundFrame,
  kind: Kind
): frame is Extract<SessionOutboundFrame, { kind: Kind }> =>
  frame.kind === kind;

const ignoreDrainFailure = async (operation: Promise<void>): Promise<void> => {
  try {
    await operation;
  } catch {
    // The background drain has no result channel; callers observe collected frames.
  }
};

/** Drains a binding's outbound frame stream into `sink` until it closes. */
const drainFramesInBackground = async (
  outbound: AsyncIterable<SessionOutboundFrame>,
  sink: SessionOutboundFrame[]
): Promise<void> => {
  const iterator = outbound[Symbol.asyncIterator]();
  const loop = drainFrames(iterator, sink);

  await ignoreDrainFailure(loop);
};

const eventFramePayloads = (
  frames: readonly SessionOutboundFrame[]
): unknown[] =>
  frames
    .filter(
      (frame): frame is Extract<SessionOutboundFrame, { kind: "event" }> =>
        frame.kind === "event"
    )
    .map((frame) => frame.event);

export const createSingleToolCallRunner = (
  toolName: string,
  callId: string,
  finalText: string
): RuntimeRunner => ({
  execute: fromSynchronous((context) => {
    if (!context.messages.some((message) => message.role === "tool")) {
      return {
        messages: [assistantToolCalls([{ callId, input: {}, name: toolName }])],
        resolution: { type: "continue_iteration" },
        toolExecutionMode: "parallel",
      };
    }

    return {
      messages: [assistantText(finalText)],
      resolution: { reason: "done", type: "end_turn" },
    };
  }),
  id: RUNNER_ID,
});

// ---------------------------------------------------------------------------
// Operation: host-session.stale-client-result
//
// Drives a real turn through a tuvren-client capability wired to a
// DuplexSessionBinding's clientEndpoint, submits an inbound client_result
// with an unknown callId (expect capability_result_stale), then submits the
// matching client_result and lets the turn complete.
// ---------------------------------------------------------------------------

export const runStaleClientResult = async (): Promise<AdapterProjection> => {
  const SESSION_ID = "sess-host-session-stale-1";
  const CAP_ID = "session.client.echo";
  const CALL_ID = "call-1";

  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    CAP_ID,
    CALL_ID,
    "host-session stale-client-result conformance complete"
  );
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const deferredEndpoint = createDeferredClientEndpoint(
    "ep-host-session-stale",
    [
      {
        capabilityId: CAP_ID,
        description: "host-session conformance echo capability",
        inputSchema: { type: "object" },
      },
    ]
  );
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [deferredEndpoint], name: AGENT_NAME },
    signal: textSignal("host-session stale client result conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: SESSION_ID,
  });
  deferredEndpoint.setDelegate(binding.clientEndpoint);

  const iterator = binding.outbound()[Symbol.asyncIterator]();
  const observedFrames: SessionOutboundFrame[] = [];

  const nextFrameOfKind = async <Kind extends SessionOutboundFrame["kind"]>(
    kind: Kind
  ): Promise<Extract<SessionOutboundFrame, { kind: Kind }>> => {
    const step = await iterator.next();
    if (step.done === true) {
      throw new Error(
        `host-session outbound stream ended before observing frame kind "${kind}"`
      );
    }
    observedFrames.push(step.value);
    return isFrameOfKind(step.value, kind)
      ? step.value
      : await nextFrameOfKind(kind);
  };

  const invocationFrame = await nextFrameOfKind("client_invocation");
  const { callId, leaseToken } = invocationFrame.invocation;

  binding.dispatchInbound({
    correlationId: "corr-stale-1",
    kind: "client_result",
    protocolVersion: "1",
    result: {
      callId: "unknown-call-id",
      content: { staleAttempt: true },
      leaseToken,
    },
    sessionId: SESSION_ID,
  });
  const rejectionFrame = await nextFrameOfKind("session_rejection");

  binding.dispatchInbound({
    correlationId: "corr-accept-1",
    kind: "client_result",
    protocolVersion: "1",
    result: { callId, content: { accepted: true }, leaseToken },
    sessionId: SESSION_ID,
  });

  await handle.awaitResult();

  // Drain any remaining outbound frames (final turn.end event etc.) until
  // the binding closes the queue behind a completed handle.
  await drainFrames(iterator, observedFrames);

  const observation = {
    accepted: { callId },
    finalPhase: handle.status().phase,
    rejection: {
      code: rejectionFrame.rejection.code,
      correlationId: rejectionFrame.rejection.correlationId,
    },
  };

  return {
    events: eventFramePayloads(observedFrames),
    evidence: observation,
    result: observation,
  };
};

// ---------------------------------------------------------------------------
// Operation: host-session.approval-response-resume
//
// Drives a turn that pauses on an approval-gated tool, submits an inbound
// approval_response frame through the binding, and observes the handle
// swap, the resumed terminal turn, and the approval.resolved event.
// ---------------------------------------------------------------------------

export const runApprovalResponseResume =
  async (): Promise<AdapterProjection> => {
    const SESSION_ID = "sess-host-session-approval-1";
    const TOOL_NAME = "session.approval.tool";
    const CALL_ID = "approve-call-1";

    const harness = createConformanceKernelHarness();
    const runner = createSingleToolCallRunner(
      TOOL_NAME,
      CALL_ID,
      "host-session approval-resume conformance complete"
    );
    const tools: TuvrenToolDefinition[] = [
      {
        approval: true,
        description: "host-session conformance approval-gated tool",
        execute() {
          return { ok: true };
        },
        inputSchema: { type: "object" },
        name: TOOL_NAME,
      },
    ];
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([runner]),
    });
    const thread = await runtime.createThread({});
    const pausedHandle = runtime.executeTurn({
      branchId: thread.branchId,
      config: { name: AGENT_NAME, tools },
      signal: textSignal("host-session approval resume conformance"),
      threadId: thread.threadId,
    });
    const binding = createDuplexSessionBinding(pausedHandle, {
      sessionId: SESSION_ID,
    });
    const frames: SessionOutboundFrame[] = [];
    const drainPromise = drainFramesInBackground(binding.outbound(), frames);

    await waitFor(() => pausedHandle.status().phase === "paused");

    binding.dispatchInbound({
      correlationId: "corr-approve-1",
      kind: "approval_response",
      protocolVersion: "1",
      response: { decisions: [{ callId: CALL_ID, type: "approve" }] },
      sessionId: SESSION_ID,
    });

    await waitFor(() => binding.currentHandle() !== pausedHandle);
    const resumedHandle = binding.currentHandle();
    await resumedHandle.awaitResult();
    await waitFor(() =>
      eventFramePayloads(frames).some(
        (event) => isRecord(event) && event.type === "turn.end"
      )
    );
    await drainPromise;

    const approvalObservation = {
      handleSwapped: resumedHandle !== pausedHandle,
      resumedPhase: resumedHandle.status().phase,
    };

    return {
      events: eventFramePayloads(frames),
      evidence: approvalObservation,
      result: approvalObservation,
    };
  };

// ---------------------------------------------------------------------------
// Operation: host-session.cancel-cooperative
//
// Drives a turn whose runner blocks on the runner execution context's abort
// signal, submits an inbound cancel frame through the binding, and observes
// the cooperative abort plus the terminal outcome.
// ---------------------------------------------------------------------------

export const runCancelCooperative = async (): Promise<AdapterProjection> => {
  const SESSION_ID = "sess-host-session-cancel-1";

  const harness = createConformanceKernelHarness();
  let runnerStarted = false;
  let toolObservedAbort = false;
  const runner: RuntimeRunner = {
    async execute(context) {
      runnerStarted = true;
      await waitForAbort(context.signal);
      toolObservedAbort = context.signal?.aborted === true;
      return { resolution: { type: "continue_iteration" } };
    },
    id: RUNNER_ID,
  };
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("host-session cancel conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: SESSION_ID,
  });
  const frames: SessionOutboundFrame[] = [];
  const drainPromise = drainFramesInBackground(binding.outbound(), frames);

  const resultPromise = handle.awaitResult();
  await waitFor(() => runnerStarted);

  binding.dispatchInbound({
    correlationId: "corr-cancel-1",
    kind: "cancel",
    protocolVersion: "1",
    sessionId: SESSION_ID,
  });

  let awaitResultStatus: string | undefined;
  let awaitResultErrorCode: string | undefined;
  try {
    const result = await resultPromise;
    awaitResultStatus = result.status;
  } catch (error) {
    awaitResultStatus = "failed";
    if (error instanceof TuvrenRuntimeError) {
      awaitResultErrorCode = error.code;
    }
  }

  await waitFor(() => toolObservedAbort);
  await drainPromise;

  const cancelObservation = {
    awaitResultErrorCode,
    awaitResultStatus,
    finalPhase: handle.status().phase,
    toolObservedAbort,
  };

  return {
    events: eventFramePayloads(frames),
    evidence: cancelObservation,
    result: cancelObservation,
  };
};

const loadHostSessionFrameValidators =
  async (): Promise<HostSessionFrameValidators> => {
    validatorsPromise ??= (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const entries = await readdir(HOST_SESSION_JSON_SCHEMA_DIR, {
        withFileTypes: true,
      });

      const schemas = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry): Promise<AnySchema> => {
            const source = await readFile(
              path.resolve(HOST_SESSION_JSON_SCHEMA_DIR, entry.name),
              "utf-8"
            );
            const schema: unknown = JSON.parse(source);
            if (!(typeof schema === "boolean" || isRecord(schema))) {
              throw new Error(
                `host-session schema ${entry.name} must be an object or boolean`
              );
            }
            return schema;
          })
      );
      for (const schema of schemas) {
        ajv.addSchema(schema);
      }

      const inbound = ajv.getSchema(SESSION_INBOUND_FRAME_ID);
      const outbound = ajv.getSchema(SESSION_OUTBOUND_FRAME_ID);

      if (inbound === undefined || outbound === undefined) {
        throw new Error(
          `host-session json-schema artifacts under ${HOST_SESSION_JSON_SCHEMA_DIR} did not register SessionInboundFrame/SessionOutboundFrame`
        );
      }

      return { inbound, outbound };
    })();

    return await validatorsPromise;
  };

export const runCancelWhilePaused = async (): Promise<AdapterProjection> => {
  const SESSION_ID = "sess-host-session-cancel-paused-1";
  const TOOL_NAME = "session.cancel-paused.tool";
  const CALL_ID = "cancel-paused-call-1";

  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    TOOL_NAME,
    CALL_ID,
    "host-session cancel-while-paused conformance complete"
  );
  const tools: TuvrenToolDefinition[] = [
    {
      approval: true,
      description: "host-session conformance approval-gated tool",
      execute() {
        return { ok: true };
      },
      inputSchema: { type: "object" },
      name: TOOL_NAME,
    },
  ];
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    kernel: harness.kernel,
    runnerRegistry: createRunnerRegistry([runner]),
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME, tools },
    signal: textSignal("host-session cancel while paused conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: SESSION_ID,
  });

  // Drain with an explicit closure marker: the behavior under test is that
  // the outbound stream terminates even though a paused handle's cancel
  // delivers its terminal outcome only through awaitResult().
  const frames: SessionOutboundFrame[] = [];
  let outboundClosed = false;
  const iterator = binding.outbound()[Symbol.asyncIterator]();
  const drainLoop = (async () => {
    await drainFrames(iterator, frames);
    outboundClosed = true;
  })();
  const drainPromise = ignoreDrainFailure(drainLoop);

  const resultPromise = handle.awaitResult();
  await waitFor(() => handle.status().phase === "paused");
  // Observed (not assumed) phase at the moment the cancel frame is sent.
  const phaseAtCancel = handle.status().phase;

  binding.dispatchInbound({
    correlationId: "corr-cancel-paused-1",
    kind: "cancel",
    protocolVersion: "1",
    sessionId: SESSION_ID,
  });

  // Cancel-while-paused is documented as rejecting the pending tool calls
  // and completing the Turn without re-entering the model — explicitly not
  // a Turn failure (KrakenFrameworkSpecification 6.10) — so the terminal
  // result resolves with status "completed" rather than rejecting.
  let awaitResultStatus: string | undefined;
  try {
    const result = await resultPromise;
    awaitResultStatus = result.status;
  } catch {
    awaitResultStatus = "failed";
  }

  await waitFor(() => outboundClosed);
  await drainPromise;

  const observation = {
    awaitResultStatus,
    outboundClosed,
    pausedBeforeCancel: phaseAtCancel === "paused",
  };

  return {
    events: eventFramePayloads(frames),
    evidence: observation,
    result: observation,
  };
};

const readFixtureEntry = (
  value: unknown,
  index: number
): HostSessionFrameFixture => {
  if (!isRecord(value)) {
    throw new Error(`host-session fixture[${index}] must be an object`);
  }

  const { name, direction, expectedValid } = value;

  if (
    typeof name !== "string" ||
    !(direction === "inbound" || direction === "outbound") ||
    typeof expectedValid !== "boolean" ||
    !("frame" in value)
  ) {
    throw new Error(
      `host-session fixture[${index}] must contain name, frame, direction ("inbound"|"outbound"), and expectedValid`
    );
  }

  return { direction, expectedValid, frame: value.frame, name };
};

const readFixtureArray = (input: unknown): HostSessionFrameFixture[] => {
  if (!(isRecord(input) && Array.isArray(input.fixture))) {
    throw new Error(
      "host-session.validate-frame-fixtures requires input.fixture to be an array"
    );
  }

  return input.fixture.map((entry, index) => readFixtureEntry(entry, index));
};

export const runValidateFrameFixtures = async (
  input: unknown
): Promise<AdapterProjection> => {
  const fixtures = readFixtureArray(input);
  const validators = await loadHostSessionFrameValidators();
  const results = fixtures.map((fixture) => {
    const validate =
      fixture.direction === "inbound"
        ? validators.inbound
        : validators.outbound;
    const actualValid = validate(fixture.frame);

    return {
      actualValid,
      direction: fixture.direction,
      expectedValid: fixture.expectedValid,
      matches: actualValid === fixture.expectedValid,
      name: fixture.name,
    };
  });

  const frameValidationObservation = {
    frameValidation: {
      allMatch: results.every((entry) => entry.matches),
      count: results.length,
      results,
    },
  };

  return {
    evidence: frameValidationObservation,
    result: frameValidationObservation,
  };
};

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
  const deferredEndpoint = createDeferredClientEndpoint("ep-reattach", [
    {
      capabilityId: REATTACH_CAP,
      description:
        "host-session reattach-redelivery conformance echo capability",
      inputSchema: { type: "object" },
    },
  ]);
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
