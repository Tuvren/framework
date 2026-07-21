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
 * duplex session frame vocabulary (issue #99, ADR-060). Each operation
 * drives a real `@tuvren/runtime` turn through `createDuplexSessionBinding`
 * (`@tuvren/host-session`) and returns structured evidence that the shared
 * certification harness asserts against `host-session.json`'s checks.
 *
 * Adapter rules: no assertion logic, no pass/fail grading, no evidence
 * field names that imply semantic verdicts. Raw observational data only.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TuvrenRuntimeError } from "@tuvren/core";
import type {
  AttachedClientEndpoint,
  ClientEndpointCapabilityAdvertisement,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type { RuntimeRunner } from "@tuvren/core/runner";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import {
  createDuplexSessionBinding,
  type SessionOutboundFrame,
} from "@tuvren/host-session";
import {
  createRemoteClientSession,
  type RemoteClientSessionSink,
  type RemoteSessionClock,
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_SESSION_JSON_SCHEMA_DIR = resolve(
  REPO_ROOT,
  "spec/host/session/artifacts/json-schema"
);
const SESSION_INBOUND_FRAME_ID =
  "https://tuvren.dev/schemas/framework/host-session/SessionInboundFrame.json";
const SESSION_OUTBOUND_FRAME_ID =
  "https://tuvren.dev/schemas/framework/host-session/SessionOutboundFrame.json";

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
  setDelegate(delegate: AttachedClientEndpoint): void;
}

function createDeferredClientEndpoint(
  endpointId: string,
  advertisedCapabilities: ClientEndpointCapabilityAdvertisement[]
): DeferredClientEndpoint {
  let delegate: AttachedClientEndpoint | undefined;

  return {
    advertisedCapabilities,
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      if (delegate === undefined) {
        throw new Error(
          "host-session conformance adapter dispatched a client invocation before the duplex session binding was wired"
        );
      }
      return delegate.dispatch(envelope);
    },
    endpointId,
    setDelegate(nextDelegate: AttachedClientEndpoint): void {
      delegate = nextDelegate;
    },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("host-session conformance adapter waitFor timed out");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

/** Drains a binding's outbound frame stream into `sink` until it closes. */
function drainFramesInBackground(
  outbound: AsyncIterable<SessionOutboundFrame>,
  sink: SessionOutboundFrame[]
): void {
  const iterator = outbound[Symbol.asyncIterator]();
  const loop = (async () => {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        return;
      }
      sink.push(step.value);
    }
  })();

  // Fire-and-forget: the only observable effect is `sink` growing, which
  // callers poll for via `waitFor`.
  loop.catch(() => undefined);
}

function eventFramePayloads(
  frames: readonly SessionOutboundFrame[]
): unknown[] {
  return frames
    .filter(
      (frame): frame is Extract<SessionOutboundFrame, { kind: "event" }> =>
        frame.kind === "event"
    )
    .map((frame) => frame.event);
}

export function createSingleToolCallRunner(
  toolName: string,
  callId: string,
  finalText: string
): RuntimeRunner {
  return {
    async execute(context) {
      await Promise.resolve();

      if (!context.messages.some((message) => message.role === "tool")) {
        return {
          messages: [
            assistantToolCalls([{ callId, input: {}, name: toolName }]),
          ],
          resolution: { type: "continue_iteration" },
          toolExecutionMode: "parallel",
        };
      }

      return {
        messages: [assistantText(finalText)],
        resolution: { reason: "done", type: "end_turn" },
      };
    },
    id: RUNNER_ID,
  };
}

// ---------------------------------------------------------------------------
// Operation: host-session.stale-client-result
//
// Drives a real turn through a tuvren-client capability wired to a
// DuplexSessionBinding's clientEndpoint, submits an inbound client_result
// with an unknown callId (expect capability_result_stale), then submits the
// matching client_result and lets the turn complete.
// ---------------------------------------------------------------------------

export async function runStaleClientResult(): Promise<AdapterProjection> {
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

  async function nextFrameOfKind<Kind extends SessionOutboundFrame["kind"]>(
    kind: Kind
  ): Promise<Extract<SessionOutboundFrame, { kind: Kind }>> {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        throw new Error(
          `host-session outbound stream ended before observing frame kind "${kind}"`
        );
      }
      observedFrames.push(step.value);
      if (step.value.kind === kind) {
        return step.value as Extract<SessionOutboundFrame, { kind: Kind }>;
      }
    }
  }

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
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      break;
    }
    observedFrames.push(step.value);
  }

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
}

// ---------------------------------------------------------------------------
// Operation: host-session.approval-response-resume
//
// Drives a turn that pauses on an approval-gated tool, submits an inbound
// approval_response frame through the binding, and observes the handle
// swap, the resumed terminal turn, and the approval.resolved event.
// ---------------------------------------------------------------------------

export async function runApprovalResponseResume(): Promise<AdapterProjection> {
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
  drainFramesInBackground(binding.outbound(), frames);

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
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "turn.end"
    )
  );

  const approvalObservation = {
    handleSwapped: resumedHandle !== pausedHandle,
    resumedPhase: resumedHandle.status().phase,
  };

  return {
    events: eventFramePayloads(frames),
    evidence: approvalObservation,
    result: approvalObservation,
  };
}

// ---------------------------------------------------------------------------
// Operation: host-session.cancel-cooperative
//
// Drives a turn whose runner blocks on the runner execution context's abort
// signal, submits an inbound cancel frame through the binding, and observes
// the cooperative abort plus the terminal outcome.
// ---------------------------------------------------------------------------

export async function runCancelCooperative(): Promise<AdapterProjection> {
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
  drainFramesInBackground(binding.outbound(), frames);

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

function loadHostSessionFrameValidators(): Promise<HostSessionFrameValidators> {
  validatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const entries = await readdir(HOST_SESSION_JSON_SCHEMA_DIR, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!(entry.isFile() && entry.name.endsWith(".json"))) {
        continue;
      }

      const schema = JSON.parse(
        await readFile(
          resolve(HOST_SESSION_JSON_SCHEMA_DIR, entry.name),
          "utf8"
        )
      ) as AnySchema;
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

  return validatorsPromise;
}

interface HostSessionFrameFixture {
  direction: "inbound" | "outbound";
  expectedValid: boolean;
  frame: unknown;
  name: string;
}

export async function runCancelWhilePaused(): Promise<AdapterProjection> {
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
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        outboundClosed = true;
        return;
      }
      frames.push(step.value);
    }
  })();
  drainLoop.catch(() => undefined);

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
}

export async function runValidateFrameFixtures(
  input: unknown
): Promise<AdapterProjection> {
  const fixtures = readFixtureArray(input);
  const validators = await loadHostSessionFrameValidators();
  const results = fixtures.map((fixture) => {
    const validate =
      fixture.direction === "inbound"
        ? validators.inbound
        : validators.outbound;
    const actualValid = validate(fixture.frame) === true;

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
}

function readFixtureArray(input: unknown): HostSessionFrameFixture[] {
  if (!(isRecord(input) && Array.isArray(input.fixture))) {
    throw new Error(
      "host-session.validate-frame-fixtures requires input.fixture to be an array"
    );
  }

  return input.fixture.map((entry, index) => readFixtureEntry(entry, index));
}

function readFixtureEntry(
  value: unknown,
  index: number
): HostSessionFrameFixture {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// ADR-063 session-lifecycle conformance: reattach redelivery, grace-window
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

function createRecordingSessionSink(): RemoteClientSessionSink & {
  sent: RecordedSessionFrame[];
} {
  const sent: RecordedSessionFrame[] = [];
  return {
    send(frame: SessionOutboundFrame, cursor?: string): void {
      sent.push({ cursor, frame });
    },
    sent,
  };
}

function sentFramesOfKind<Kind extends SessionOutboundFrame["kind"]>(
  sent: readonly RecordedSessionFrame[],
  kind: Kind
): Extract<SessionOutboundFrame, { kind: Kind }>[] {
  return sent
    .map((entry) => entry.frame)
    .filter(
      (frame): frame is Extract<SessionOutboundFrame, { kind: Kind }> =>
        frame.kind === kind
    );
}

/** A deterministic, test-controlled `RemoteSessionClock`: timers only fire when the adapter explicitly calls {@link fireOldest}. Mirrors `@tuvren/remote-session`'s own test fake; kept local since adapters do not import another package's test sources. */
function createFakeSessionClock(): {
  clock: RemoteSessionClock;
  fireOldest(): void;
  pendingCount(): number;
} {
  let nextId = 0;
  const timers = new Map<number, () => void>();

  const clock: RemoteSessionClock = {
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
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
      const ids = [...timers.keys()].sort((a, b) => a - b);
      const id = ids[0];
      if (id === undefined) {
        throw new Error("createFakeSessionClock.fireOldest: no pending timer");
      }
      const callback = timers.get(id);
      timers.delete(id);
      callback?.();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** Reads back the durably staged `tool_result` part matching `callId` from a branch's persisted messages, mirroring the shape `tool.result` events carry (`isError`, `output`). */
function findPersistedToolResultOutput(
  messages: readonly unknown[],
  callId: string
): { isError: boolean; output: unknown } | undefined {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") {
      continue;
    }
    const parts = message.parts;
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
}

function toolResultOutputCode(output: unknown): string | undefined {
  return isRecord(output) && typeof output.code === "string"
    ? output.code
    : undefined;
}

const SESSION_LIFECYCLE_REPLAY_CAPACITY = 200;

// ---------------------------------------------------------------------------
// Operation: host-session.reattach-redelivery
//
// ADR-063 decision 3: an unanswered client_invocation is redelivered to the
// next attached sink after a detach, with its original callId, leaseToken,
// and idempotencyKey preserved (redelivery is safe because the correlation
// handles already in the wire vocabulary make it safe, not because of a new
// delivery-guarantee layer). session_rejection frames are never redelivered.
// ---------------------------------------------------------------------------

const REATTACH_SESSION_ID = "sess-host-session-reattach-1";
const REATTACH_CAP = "session.reattach.echo";
const REATTACH_CALL_ID = "reattach-call-1";

export async function runReattachRedelivery(): Promise<AdapterProjection> {
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
    ?.invocation as ClientInvocationEnvelope;

  // Simulate a dropped link: detach without ever answering the call.
  session.detach();

  const sink2 = createRecordingSessionSink();
  session.attach(sink2);
  await waitFor(
    () => sentFramesOfKind(sink2.sent, "client_invocation").length > 0
  );
  const secondInvocation = sentFramesOfKind(sink2.sent, "client_invocation")[0]
    ?.invocation as ClientInvocationEnvelope;

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
}

// ---------------------------------------------------------------------------
// Operation: host-session.grace-window-expiry
//
// ADR-063 decision 4: detach starts a disconnectGraceMs timer instead of
// failing in-flight dispatches immediately; expiry settles every pending
// dispatch with capability_binding_unavailable and permanently ends the
// session. Verified against the persisted kernel record read back after the
// turn completes, not against an in-flight event capture.
// ---------------------------------------------------------------------------

const GRACE_SESSION_ID = "sess-host-session-grace-1";
const GRACE_CAP = "session.grace.echo";
const GRACE_CALL_ID = "grace-call-1";

export async function runGraceWindowExpiry(): Promise<AdapterProjection> {
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

  const pendingTimersBeforeDetach = fakeClock.pendingCount();
  session.detach();
  const pendingTimersAfterDetach = fakeClock.pendingCount();
  fakeClock.fireOldest();

  const result = await handle.awaitResult();
  const persistedMessages = await harness.readBranchMessages(thread.branchId);
  const persistedToolResult = findPersistedToolResultOutput(
    persistedMessages,
    GRACE_CALL_ID
  );

  const observation = {
    finalStatus: result.status,
    pendingTimersAfterDetach,
    pendingTimersBeforeDetach,
    persistedToolResultOutputCode:
      toolResultOutputCode(persistedToolResult?.output) ?? null,
    sessionEnded: session.isEnded(),
  };

  return { evidence: observation, result: observation };
}

// ---------------------------------------------------------------------------
// Operation: host-session.dispatch-timeout
//
// ADR-063 decision 5: the dispatch clock measures peer responsiveness only,
// so it is suspended while detached and restarted (full budget) for any
// invocation redelivered on reattach. Timer-pending counts observed at each
// step mirror `remote-client-session.test.ts`'s own dispatch-timeout test;
// the terminal outcome is verified against the persisted kernel record.
// ---------------------------------------------------------------------------

const TIMEOUT_SESSION_ID = "sess-host-session-dispatch-timeout-1";
const TIMEOUT_CAP = "session.dispatch-timeout.echo";
const TIMEOUT_CALL_ID = "dispatch-timeout-call-1";

export async function runDispatchTimeout(): Promise<AdapterProjection> {
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
  const pendingTimersWhileAttached = fakeClock.pendingCount();

  session.detach();
  const pendingTimersAfterDetach = fakeClock.pendingCount();

  const sink2 = createRecordingSessionSink();
  session.attach(sink2);
  const pendingTimersAfterReattach = fakeClock.pendingCount();
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
    pendingTimersAfterDetach,
    pendingTimersAfterReattach,
    pendingTimersWhileAttached,
    persistedToolResultOutputCode:
      toolResultOutputCode(persistedToolResult?.output) ?? null,
    redeliveredInvocationCount,
  };

  return { evidence: observation, result: observation };
}

// ---------------------------------------------------------------------------
// Operation: host-session.sequence-continuity
//
// ADR-063 decision 2: one sequencer, one replay buffer, for the session's
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

export async function runSequenceContinuity(): Promise<AdapterProjection> {
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
  await waitFor(
    () => sentFramesOfKind(sink1.sent, "client_invocation").length > 0
  );
  const invocation = sentFramesOfKind(sink1.sent, "client_invocation")[0]
    ?.invocation as ClientInvocationEnvelope;

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

  await waitFor(() => sink1.sent.some((entry) => entry.frame.kind === "event"));
  const eventFramesBeforeDetach = sink1.sent.filter(
    (entry): entry is RecordedSessionFrame & { cursor: string } =>
      entry.frame.kind === "event" && typeof entry.cursor === "string"
  );
  const lastCursorBeforeDetach = eventFramesBeforeDetach.at(-1)?.cursor;
  const lastSequenceBeforeDetach =
    lastCursorBeforeDetach === undefined
      ? undefined
      : decodeResumeCursor(lastCursorBeforeDetach)?.sequence;

  // Simulated drop, not session.close(): detaches this sink without ending
  // the still-running turn (ADR-063 decision 4). The pump keeps recording
  // further sequenced events into the shared replay buffer regardless of
  // attachment.
  session.detach();

  const sink2 = createRecordingSessionSink();
  const { resumeStatus } =
    lastCursorBeforeDetach === undefined
      ? session.attach(sink2)
      : session.attach(sink2, { cursor: lastCursorBeforeDetach });

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
    lastSequenceBeforeDetach === undefined
      ? []
      : replayedSequences.map(
          (_, index) => (lastSequenceBeforeDetach as number) + 1 + index
        );

  const observation = {
    expectedReplaySequences,
    lastSequenceBeforeDetach: lastSequenceBeforeDetach ?? null,
    noSequenceRestart: replayedSequences.every(
      (sequence) =>
        sequence !== null &&
        sequence > (lastSequenceBeforeDetach ?? Number.NEGATIVE_INFINITY)
    ),
    // Guards the vacuous-empty case: expectedReplaySequences is derived from
    // replayedSequences' own length, so with zero replayed events both the
    // gapless and no-restart comparisons would be trivially true. A resumed
    // reattach in this scenario must actually replay the events recorded
    // while detached; a plan assertion requires this to be true.
    replayObservedAtLeastOneEvent: replayedSequences.length > 0,
    replayGaplessAndContiguous:
      JSON.stringify(replayedSequences) ===
      JSON.stringify(expectedReplaySequences),
    replayedSequences,
    resumeStatus,
  };

  return { evidence: observation, result: observation };
}
