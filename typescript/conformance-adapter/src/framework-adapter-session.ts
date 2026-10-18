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
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
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
export interface DeferredClientEndpoint extends AttachedClientEndpoint {
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

export const createDeferredClientEndpoint = (
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
