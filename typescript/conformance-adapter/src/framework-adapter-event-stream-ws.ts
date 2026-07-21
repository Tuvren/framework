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
 * Conformance adapter operations for the `tuvren.framework.event-stream-ws`
 * WebSocket carriage packet (ADR-062, `spec/streaming/ws/`). Two families:
 * pure decode-trace checks over `parseWsMessage` (no runtime involved), and
 * live-session checks that drive a real `@tuvren/runtime` turn through
 * `createDuplexSessionBinding` + `createWsSessionTransport`, mirroring the
 * runtime-fixture machinery in `framework-adapter-session.ts`.
 *
 * Adapter rules: observation only. No assertion logic, no pass/fail grading,
 * no check-scoped identifiers, no evidence emission. Raw structural facts
 * under `result.ws.*`.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachedClientEndpoint } from "@tuvren/core/capabilities";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type {
  DuplexSessionBinding,
  SessionOutboundFrame,
} from "@tuvren/host-session";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import {
  createRemoteClientSession,
  type RemoteClientSession,
} from "@tuvren/remote-session";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import { decodeResumeCursor } from "@tuvren/stream-core";
import {
  createWsSessionTransport,
  type ParsedWsMessage,
  parseWsMessage,
  type WsSessionTransport,
  type WsSocketSink,
} from "@tuvren/stream-ws";
import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import {
  createSingleToolCallRunner,
  waitFor,
} from "./framework-adapter-session.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WS_JSON_SCHEMA_DIR = resolve(
  REPO_ROOT,
  "spec/streaming/ws/artifacts/json-schema"
);
const WS_SCHEMA_IDS: Record<string, string> = {
  frame:
    "https://tuvren.dev/schemas/framework/event-stream-ws/WsOutboundFrameEnvelope.json",
  handshake_ack:
    "https://tuvren.dev/schemas/framework/event-stream-ws/WsHandshakeAck.json",
  ping: "https://tuvren.dev/schemas/framework/event-stream-ws/WsPing.json",
  pong: "https://tuvren.dev/schemas/framework/event-stream-ws/WsPong.json",
};

export function createFrameworkAdapterEventStreamWs(): {
  runDecodeTrace(input: unknown): Promise<AdapterProjection>;
  runHandshakeRejections(input: unknown): Promise<AdapterProjection>;
  runPolicyClosures(input: unknown): Promise<AdapterProjection>;
  runReconnectWithCursor(): Promise<AdapterProjection>;
  runSessionRoundtrip(): Promise<AdapterProjection>;
} {
  return {
    runDecodeTrace,
    runHandshakeRejections,
    runPolicyClosures,
    runReconnectWithCursor,
    runSessionRoundtrip,
  };
}

// ---------------------------------------------------------------------------
// Operation: decode trace
// ---------------------------------------------------------------------------

function runDecodeTrace(input: unknown): Promise<AdapterProjection> {
  const fixture = readFixtureRecord(input, "decode-trace");
  const wire = readStringField(fixture, "wire");
  const parsed = parseWsMessage(wire);

  return Promise.resolve({
    result: { ws: { decode: projectParsedMessage(parsed) } },
  });
}

function projectParsedMessage(
  parsed: ParsedWsMessage
): Record<string, unknown> {
  switch (parsed.kind) {
    case "handshake": {
      return {
        handshake: {
          authToken: parsed.message.authToken ?? null,
          cursor: parsed.message.cursor ?? null,
          protocolVersion: parsed.message.protocolVersion,
          sessionId: parsed.message.sessionId ?? null,
        },
        kind: parsed.kind,
      };
    }
    case "handshake_ack": {
      return {
        handshakeAck: {
          protocolVersion: parsed.message.protocolVersion,
          resumeStatus: parsed.message.resumeStatus,
          sessionId: parsed.message.sessionId,
        },
        kind: parsed.kind,
      };
    }
    case "frame": {
      return {
        frame: { present: parsed.frame !== undefined },
        kind: parsed.kind,
      };
    }
    case "ping":
    case "pong":
    case "unparseable": {
      return { kind: parsed.kind };
    }
    default: {
      return assertNeverParsed(parsed);
    }
  }
}

function assertNeverParsed(value: never): never {
  throw new Error(`unrecognized parsed ws message ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// ADR-063 composition helper: binding → session → transport → socket.
//
// @tuvren/stream-ws no longer takes a DuplexSessionBinding or a replay
// buffer; it attaches beneath a @tuvren/remote-session RemoteClientSession,
// which owns the single outbound() claim, the one sequencer, and the one
// replay buffer for the session's whole life. Because the session (not the
// transport) now owns the pump driving binding.outbound(), the transport has
// no intrinsic "the turn ended, close the socket" signal — that is
// RemoteClientSessionOptions.onEnded, and wiring it to whichever transport is
// currently attached is a host-composition responsibility every caller of
// this helper gets for free.
// ---------------------------------------------------------------------------

const WS_ADAPTER_DISCONNECT_GRACE_MS = 30_000;
const WS_ADAPTER_DISPATCH_TIMEOUT_MS = 30_000;
const WS_ADAPTER_REPLAY_BUFFER_CAPACITY = 200;

interface SessionComposition {
  attachTransport(sink: WsSocketSink): WsSessionTransport;
  session: RemoteClientSession;
}

function createSessionComposition(
  binding: DuplexSessionBinding
): SessionComposition {
  let currentTransport: WsSessionTransport | undefined;
  const session = createRemoteClientSession({
    binding,
    disconnectGraceMs: WS_ADAPTER_DISCONNECT_GRACE_MS,
    dispatchTimeoutMs: WS_ADAPTER_DISPATCH_TIMEOUT_MS,
    onEnded: (reason) => currentTransport?.close(1000, reason),
    replayBufferCapacity: WS_ADAPTER_REPLAY_BUFFER_CAPACITY,
  });

  return {
    attachTransport(sink: WsSocketSink): WsSessionTransport {
      const transport = createWsSessionTransport({ session, sink });
      currentTransport = transport;
      return transport;
    },
    session,
  };
}

// ---------------------------------------------------------------------------
// Operation: session roundtrip
//
// Drives a real runtime turn through the binding → session → transport
// composition above, and observes the wire trace a recording sink captures:
// handshake_ack first, every subsequent message a frame envelope, cursors
// strictly increasing from 0, and schema validity of every sent message.
// ---------------------------------------------------------------------------

const WS_ROUNDTRIP_SESSION_ID = "sess-ws-roundtrip-1";
const WS_ROUNDTRIP_TOOL_NAME = "ws.session-roundtrip.tool";
const WS_ROUNDTRIP_CALL_ID = "ws-roundtrip-call-1";

async function runSessionRoundtrip(): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    WS_ROUNDTRIP_TOOL_NAME,
    WS_ROUNDTRIP_CALL_ID,
    "ws session roundtrip conformance complete"
  );
  const tools: TuvrenToolDefinition[] = [
    {
      description: "event-stream-ws conformance session-roundtrip tool",
      execute() {
        return { ok: true };
      },
      inputSchema: { type: "object" },
      name: WS_ROUNDTRIP_TOOL_NAME,
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
    signal: textSignal("ws session roundtrip conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: WS_ROUNDTRIP_SESSION_ID,
  });
  const composition = createSessionComposition(binding);
  const sink = createRecordingSink();
  const transport = composition.attachTransport(sink);

  transport.start();
  transport.ingest(JSON.stringify({ kind: "handshake", protocolVersion: "1" }));
  await waitFor(() => sink.closes.length > 0);

  const validators = await loadWsMessageValidators();
  const sent = sink.sent as Record<string, unknown>[];
  const first = sent[0];
  const subsequent = sent.slice(1);
  const cursorSequences = subsequent
    .filter((message) => typeof message.cursor === "string")
    .map(
      (message) =>
        decodeResumeCursor(message.cursor as string)?.sequence ?? null
    );

  const observation = {
    allMessagesSchemaValid: sent.every((message) =>
      validateWsMessage(message, validators)
    ),
    allSubsequentAreFrame: subsequent.every(
      (message) => message.kind === "frame"
    ),
    cursorSequences,
    firstMessageKind: first?.kind ?? null,
    firstMessageResumeStatus: first?.resumeStatus ?? null,
    firstMessageSessionId: first?.sessionId ?? null,
    sentMessageCount: sent.length,
    sequencesStrictlyIncreasingFromZero:
      isStrictlyIncreasingFromZero(cursorSequences),
  };

  return { result: { ws: { session: observation } } };
}

// ---------------------------------------------------------------------------
// Operation: reconnect with cursor
//
// ADR-063: sequencer and replay-buffer ownership moved host-side into
// @tuvren/remote-session, so a real cross-socket reconnect over the SAME
// session (not a second, independently-claimed binding) is now possible and
// is exactly what this operation exercises. A first transport observes a
// few sequenced frames from a real runtime turn, is then closed early
// (simulating a dropped link — this only detaches the sink from the
// session, per ADR-063 decision 4, it does not end the session), and a
// second transport attaches to the SAME session with a cursor captured from
// the first frame it ever saw. Because the underlying turn may still be
// producing further events at the moment of reconnect, this operation
// cannot know in advance exactly how many frames the replay burst will
// contain; what it CAN assert without racing the turn's own pace is that the
// replay is gapless and contiguous starting immediately after the resume
// cursor's sequence number — `expectedReplaySequences` is computed as that
// arithmetic progression, independently of what actually arrived, so a
// dropped or duplicated frame in the replay would make the two arrays
// diverge.
// ---------------------------------------------------------------------------

const WS_RECONNECT_SESSION_ID = "sess-ws-reconnect-1";
const WS_RECONNECT_TOOL_NAME = "ws.reconnect.tool";
const WS_RECONNECT_CALL_ID = "ws-reconnect-call-1";

async function runReconnectWithCursor(): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  const runner = createSingleToolCallRunner(
    WS_RECONNECT_TOOL_NAME,
    WS_RECONNECT_CALL_ID,
    "ws reconnect conformance complete"
  );
  const tools: TuvrenToolDefinition[] = [
    {
      description: "event-stream-ws conformance reconnect tool",
      execute() {
        return { ok: true };
      },
      inputSchema: { type: "object" },
      name: WS_RECONNECT_TOOL_NAME,
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
    signal: textSignal("ws reconnect conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: WS_RECONNECT_SESSION_ID,
  });
  const composition = createSessionComposition(binding);

  const firstSink = createRecordingSink();
  const firstTransport = composition.attachTransport(firstSink);

  firstTransport.start();
  firstTransport.ingest(
    JSON.stringify({ kind: "handshake", protocolVersion: "1" })
  );

  // Wait for at least two sequenced frames before simulating the drop: a
  // cursor from the very first frame guarantees at least one further frame
  // is already retained in the session's replay buffer, so the reconnect
  // below is guaranteed a non-empty "resumed" replay regardless of exactly
  // how fast the underlying turn is producing events.
  await waitFor(
    () =>
      countFrameMessagesWithCursor(
        firstSink.sent as Record<string, unknown>[]
      ) >= 2
  );

  const firstFrames = (firstSink.sent as Record<string, unknown>[]).filter(
    (message) => message.kind === "frame" && typeof message.cursor === "string"
  );
  const midCursor = firstFrames[0]?.cursor as string;
  const midSequence = decodeResumeCursor(midCursor)?.sequence;

  // Simulated drop: detaches this sink from the session (ADR-063 decision
  // 4) without ending it — the underlying turn keeps running.
  firstTransport.close();

  const secondSink = createRecordingSink();
  const secondTransport = composition.attachTransport(secondSink);

  secondTransport.start();
  secondTransport.ingest(
    JSON.stringify({
      cursor: midCursor,
      kind: "handshake",
      protocolVersion: "1",
    })
  );
  // The session eventually ends (the turn completes) and, per the
  // composition helper's onEnded wiring, closes whichever transport is
  // currently attached — the second one.
  await waitFor(() => secondSink.closes.length > 0);

  const secondSent = secondSink.sent as Record<string, unknown>[];
  const ack = secondSent[0];
  const replayedSequences = secondSent
    .slice(1)
    .filter((message) => message.kind === "frame")
    .map(
      (message) =>
        decodeResumeCursor(message.cursor as string)?.sequence ?? null
    );
  const expectedReplaySequences =
    midSequence === undefined
      ? []
      : replayedSequences.map((_, index) => midSequence + 1 + index);

  const observation = {
    ackResumeStatus: ack?.resumeStatus ?? null,
    expectedReplaySequences,
    replayedSequences,
  };

  return { result: { ws: { reconnect: observation } } };
}

function countFrameMessagesWithCursor(
  messages: readonly Record<string, unknown>[]
): number {
  return messages.filter(
    (message) => message.kind === "frame" && typeof message.cursor === "string"
  ).length;
}

// ---------------------------------------------------------------------------
// Operation: handshake rejections
//
// Exercises all four handshake rejection paths against fresh transports over
// structural fake bindings and reports the observed close codes.
// ---------------------------------------------------------------------------

async function runHandshakeRejections(
  input: unknown
): Promise<AdapterProjection> {
  const fixture = readSessionScenarioFixture(input, "handshake-rejections");
  const wrongProtocolVersion = readStringField(fixture, "wrongProtocolVersion");
  const wrongSessionId = readStringField(fixture, "wrongSessionId");
  const boundSessionId = "sess-ws-rejections-1";

  const nonHandshakeFirstMessageCloseCode = await observeRejectionClose(
    boundSessionId,
    (transport) => {
      transport.ingest(JSON.stringify({ kind: "ping" }));
    }
  );

  const protocolVersionMismatchCloseCode = await observeRejectionClose(
    boundSessionId,
    (transport) => {
      transport.ingest(
        JSON.stringify({
          kind: "handshake",
          protocolVersion: wrongProtocolVersion,
        })
      );
    }
  );

  const sessionMismatchCloseCode = await observeRejectionClose(
    boundSessionId,
    (transport) => {
      transport.ingest(
        JSON.stringify({
          kind: "handshake",
          protocolVersion: "1",
          sessionId: wrongSessionId,
        })
      );
    }
  );

  const authRejectedCloseCode = await observeRejectionClose(
    boundSessionId,
    (transport) => {
      transport.ingest(
        JSON.stringify({ kind: "handshake", protocolVersion: "1" })
      );
    },
    { authorize: () => false }
  );

  const observation = {
    authRejectedCloseCode,
    nonHandshakeFirstMessageCloseCode,
    protocolVersionMismatchCloseCode,
    sessionMismatchCloseCode,
  };

  return { result: { ws: { handshakeRejections: observation } } };
}

async function observeRejectionClose(
  sessionId: string,
  drive: (transport: ReturnType<typeof createWsSessionTransport>) => void,
  options?: {
    authorize?: (authToken: string | undefined) => boolean | Promise<boolean>;
  }
): Promise<number | null> {
  const fake = createFakeBinding([], sessionId);
  const session = createTestRemoteClientSession(fake.binding);
  const sink = createRecordingSink();
  const transport = createWsSessionTransport({
    authorize: options?.authorize,
    session,
    sink,
  });

  transport.start();
  drive(transport);
  await waitFor(() => sink.closes.length > 0);

  return sink.closes[0]?.code ?? null;
}

// ---------------------------------------------------------------------------
// Operation: policy closures
//
// Liveness: heartbeat with tiny intervals against a silent fake peer.
// Backpressure: a scripted bufferedAmount overflow on a client_invocation
// send.
// ---------------------------------------------------------------------------

async function runPolicyClosures(input: unknown): Promise<AdapterProjection> {
  const fixture = readSessionScenarioFixture(input, "policy-closures");
  const heartbeat = readRecordField(fixture, "heartbeat");
  const backpressure = readRecordField(fixture, "backpressure");
  const intervalMs = readNumberField(heartbeat, "intervalMs");
  const timeoutMs = readNumberField(heartbeat, "timeoutMs");
  const maxBufferedBytes = readNumberField(backpressure, "maxBufferedBytes");
  const overflowBufferedAmount = readNumberField(
    backpressure,
    "overflowBufferedAmount"
  );
  const sessionId = "sess-ws-policy-1";

  const livenessFake = createFakeBinding([], sessionId);
  const livenessSession = createTestRemoteClientSession(livenessFake.binding);
  const livenessSink = createRecordingSink();
  const livenessTransport = createWsSessionTransport({
    heartbeat: { intervalMs, timeoutMs },
    session: livenessSession,
    sink: livenessSink,
  });

  livenessTransport.start();
  livenessTransport.ingest(
    JSON.stringify({ kind: "handshake", protocolVersion: "1" })
  );
  await waitFor(
    () => livenessSink.closes.length > 0,
    intervalMs + timeoutMs + 5000
  );

  const invocationFrame: SessionOutboundFrame = {
    invocation: {
      callId: "ws-policy-call-1",
      capabilityId: "ws.policy.capability",
      input: {},
      leaseToken: "ws-policy-lease-1",
    },
    kind: "client_invocation",
    protocolVersion: "1",
    sessionId,
  };
  const backpressureFake = createFakeBinding([invocationFrame], sessionId);
  const backpressureSession = createTestRemoteClientSession(
    backpressureFake.binding
  );
  const backpressureSink = createScriptedBufferedAmountSink([
    overflowBufferedAmount,
  ]);
  const backpressureTransport = createWsSessionTransport({
    backpressure: { maxBufferedBytes },
    session: backpressureSession,
    sink: backpressureSink,
  });

  backpressureTransport.start();
  backpressureTransport.ingest(
    JSON.stringify({ kind: "handshake", protocolVersion: "1" })
  );
  await waitFor(() => backpressureSink.closes.length > 0);

  const observation = {
    backpressureCloseCode: backpressureSink.closes[0]?.code ?? null,
    backpressureSentFrameCount: (
      backpressureSink.sent as Record<string, unknown>[]
    ).filter((message) => message.kind === "frame").length,
    heartbeatCloseCode: livenessSink.closes[0]?.code ?? null,
  };

  return { result: { ws: { policyClosures: observation } } };
}

// ---------------------------------------------------------------------------
// Shared structural fakes (mirrors
// typescript/streaming/ws/test/ws-transport-policies.test.ts) and WS
// JSON Schema validation.
// ---------------------------------------------------------------------------

interface FakeBindingResult {
  binding: DuplexSessionBinding;
  dispatched: unknown[];
}

/** Wraps a structural fake `DuplexSessionBinding` in a `RemoteClientSession` with generous grace/timeout defaults (these fixtures never exercise reattach/redelivery — only handshake and heartbeat/backpressure policy — so the exact values are not load-bearing). */
function createTestRemoteClientSession(
  binding: DuplexSessionBinding
): RemoteClientSession {
  return createRemoteClientSession({
    binding,
    disconnectGraceMs: WS_ADAPTER_DISCONNECT_GRACE_MS,
    dispatchTimeoutMs: WS_ADAPTER_DISPATCH_TIMEOUT_MS,
    replayBufferCapacity: WS_ADAPTER_REPLAY_BUFFER_CAPACITY,
  });
}

const unusedClientEndpoint: AttachedClientEndpoint = {
  advertisedCapabilities: [],
  dispatch(): Promise<never> {
    return Promise.reject(
      new Error(
        "event-stream-ws conformance fake binding clientEndpoint.dispatch is unused"
      )
    );
  },
  endpointId: "event-stream-ws-conformance-unused-endpoint",
};

function createFakeBinding(
  outboundFrames: SessionOutboundFrame[],
  sessionId: string
): FakeBindingResult {
  const dispatched: unknown[] = [];
  let index = 0;
  let claimed = false;

  const binding: DuplexSessionBinding = {
    clientEndpoint: unusedClientEndpoint,
    currentHandle(): never {
      throw new Error(
        "currentHandle is unused by the event-stream-ws conformance fake binding"
      );
    },
    dispatchInbound(frame: unknown): void {
      dispatched.push(frame);
    },
    outbound(): AsyncIterable<SessionOutboundFrame> {
      if (claimed) {
        throw new Error(
          "outbound() may only be called once per DuplexSessionBinding"
        );
      }
      claimed = true;

      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionOutboundFrame> {
          return {
            next(): Promise<IteratorResult<SessionOutboundFrame>> {
              if (index < outboundFrames.length) {
                const value = outboundFrames[index] as SessionOutboundFrame;
                index += 1;
                return Promise.resolve({ done: false, value });
              }

              return new Promise<IteratorResult<SessionOutboundFrame>>(() => {
                // Never resolves: models a still-open live connection.
              });
            },
            // biome-ignore lint/suspicious/useAwait: intentionally synchronous resolution.
            async return(): Promise<IteratorResult<SessionOutboundFrame>> {
              index = outboundFrames.length;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    sessionId,
  };

  return { binding, dispatched };
}

interface RecordingSink extends WsSocketSink {
  closes: Array<{ code: number; reason: string | undefined }>;
  sent: unknown[];
}

function createRecordingSink(): RecordingSink {
  const sent: unknown[] = [];
  const closes: Array<{ code: number; reason: string | undefined }> = [];

  return {
    close(code: number, reason?: string): void {
      closes.push({ code, reason });
    },
    closes,
    send(data: string): void {
      sent.push(JSON.parse(data));
    },
    sent,
  };
}

function createScriptedBufferedAmountSink(script: number[]): RecordingSink {
  const sink = createRecordingSink();
  let index = 0;

  sink.bufferedAmount = (): number => {
    const value = script[Math.min(index, script.length - 1)] as number;
    index += 1;
    return value;
  };

  return sink;
}

let wsValidatorsPromise: Promise<Map<string, ValidateFunction>> | undefined;

function loadWsMessageValidators(): Promise<Map<string, ValidateFunction>> {
  wsValidatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const entries = await readdir(WS_JSON_SCHEMA_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!(entry.isFile() && entry.name.endsWith(".json"))) {
        continue;
      }

      const schema = JSON.parse(
        await readFile(resolve(WS_JSON_SCHEMA_DIR, entry.name), "utf8")
      ) as AnySchema;
      ajv.addSchema(schema);
    }

    const validators = new Map<string, ValidateFunction>();

    for (const [kind, schemaId] of Object.entries(WS_SCHEMA_IDS)) {
      const validate = ajv.getSchema(schemaId);

      if (validate === undefined) {
        throw new Error(
          `event-stream-ws json-schema artifacts under ${WS_JSON_SCHEMA_DIR} did not register ${schemaId}`
        );
      }

      validators.set(kind, validate);
    }

    return validators;
  })();

  return wsValidatorsPromise;
}

function validateWsMessage(
  message: Record<string, unknown>,
  validators: Map<string, ValidateFunction>
): boolean {
  const kind = typeof message.kind === "string" ? message.kind : undefined;
  const validate = kind === undefined ? undefined : validators.get(kind);

  return validate !== undefined && validate(message) === true;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isStrictlyIncreasingFromZero(
  sequences: readonly (number | null)[]
): boolean {
  return (
    sequences.length > 0 && sequences.every((value, index) => value === index)
  );
}

function readFixtureRecord(
  input: unknown,
  operation: string
): Record<string, unknown> {
  if (isRecord(input) && isRecord((input as { fixture?: unknown }).fixture)) {
    return (input as { fixture: Record<string, unknown> }).fixture;
  }

  throw new Error(
    `${operation} expects the runner to supply the resolved fixture object under input.fixture`
  );
}

function readSessionScenarioFixture(
  input: unknown,
  label: string
): Record<string, unknown> {
  return readFixtureRecord(input, `event-stream-ws.${label}`);
}

function readStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];

  if (typeof value !== "string") {
    throw new Error(
      `event-stream-ws fixture is missing a string "${key}" property`
    );
  }

  return value;
}

function readNumberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];

  if (typeof value !== "number") {
    throw new Error(
      `event-stream-ws fixture is missing a numeric "${key}" property`
    );
  }

  return value;
}

function readRecordField(
  source: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = source[key];

  if (!isRecord(value)) {
    throw new Error(
      `event-stream-ws fixture is missing an object "${key}" property`
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
