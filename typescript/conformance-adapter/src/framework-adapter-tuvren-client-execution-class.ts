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
 * Conformance adapter operations for the Tuvren-client execution class
 * check set (KRT-AZ006). Each operation returns structured evidence that
 * the shared certification harness asserts against the tuvren-client-execution-class
 * plan's checks.
 *
 * Adapter rules: no assertion logic, no pass/fail grading, no evidence
 * field names that imply semantic verdicts. Raw observational data only.
 */

import { createMemoryBackend } from "@tuvren/backend-memory";
import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createRemoteClientSession } from "@tuvren/remote-session";
import {
  createBindingResolver,
  createClientEndpointBoundary,
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import {
  createWsSessionTransport,
  type WsSessionTransport,
  type WsSocketSink,
} from "@tuvren/stream-ws";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";
import { waitFor } from "./framework-adapter-session.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeSingleCallRunner(toolName: string) {
  return createStaticRunner(async (context) => {
    await Promise.resolve();
    if (!context.messages.some((m) => m.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            { callId: "az-call-1", input: {}, name: toolName },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel" as const,
      };
    }
    return {
      messages: [assistantText("az006 done")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
}

function makeOkEndpoint(
  endpointId: string,
  capabilityId: string,
  content: unknown
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: `${capabilityId} conformance cap`,
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content,
        leaseToken: envelope.leaseToken,
      });
    },
  };
}

function makeClientMcpEndpoint(
  endpointId: string,
  capabilityId: string,
  mcpServerName: string,
  content: unknown
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: `${capabilityId} client-mcp cap`,
        inputSchema: { type: "object" },
        mcpServerName,
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content,
        leaseToken: envelope.leaseToken,
      });
    },
  };
}

function makeStaleEndpoint(
  endpointId: string,
  capabilityId: string
): AttachedClientEndpoint {
  return {
    endpointId,
    advertisedCapabilities: [
      {
        capabilityId,
        description: `${capabilityId} stale cap`,
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content: { staleContent: true },
        leaseToken: "stale-token-for-conformance", // will never match the envelope token
      });
    },
  };
}

async function runTurn(
  toolName: string,
  endpoints: AttachedClientEndpoint[],
  clientEndpointBoundary?: import("@tuvren/core/capabilities").ClientEndpointBoundary
) {
  const harness = createConformanceKernelHarness();
  const runner = makeSingleCallRunner(toolName);
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      name: AGENT_NAME,
      clientEndpoints: endpoints,
      ...(clientEndpointBoundary === undefined
        ? {}
        : { clientEndpointBoundary }),
    },
    signal: textSignal("az006 conformance"),
    threadId: thread.threadId,
  });
  const events = await collectValues(handle.events());
  const result = await handle.awaitResult();
  return { events, result };
}

function findAllEvents(events: unknown[], type: string) {
  return events.filter(
    (e) => (e as Record<string, unknown>).type === type
  ) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Operation: runtime.tuvren-client.lifecycle
//
// Exercises AZ001–AZ005 in one structured operation:
// - Normal attach/dispatch/result capture (AZ001, AZ002)
// - Unavailable endpoint (detach → capability_binding_unavailable) (AZ003)
// - Stale late-completion (mismatched leaseToken → stale content not surfaced) (AZ003)
// - Client-side MCP binding classification (AZ004)
// - Partial observability limits (no tool.audit events) (AZ005)
// ---------------------------------------------------------------------------

export async function runTuvrenClientLifecycle(): Promise<AdapterProjection> {
  // --- 1. Normal dispatch: attach endpoint, dispatch, capture result ---
  const NORMAL_CAP = "az006.client.normal";
  const normalEndpoint = makeOkEndpoint("ep-normal", NORMAL_CAP, {
    conformanceResult: "ok",
  });
  const normalRun = await runTurn(NORMAL_CAP, [normalEndpoint]);
  const normalResultEvents = findAllEvents(normalRun.events, "tool.result");
  const normalStartEvents = findAllEvents(normalRun.events, "tool.start");
  const normalAuditEvents = findAllEvents(normalRun.events, "tool.audit");
  const normalResultEvent = normalResultEvents[0] as
    | Record<string, unknown>
    | undefined;

  // --- 2. Unavailable endpoint: detach before turn, assert typed code ---
  const UNAVAILABLE_CAP = "az006.client.unavailable";
  const unavailableEndpoint = makeOkEndpoint(
    "ep-unavailable",
    UNAVAILABLE_CAP,
    { shouldNotReach: true }
  );
  const preDetachedBoundary = createClientEndpointBoundary([
    unavailableEndpoint,
  ]);
  preDetachedBoundary.detach("ep-unavailable");
  const unavailableRun = await runTurn(
    UNAVAILABLE_CAP,
    [unavailableEndpoint],
    preDetachedBoundary
  );
  const unavailableResultEvents = findAllEvents(
    unavailableRun.events,
    "tool.result"
  );
  const unavailableResultEvent = unavailableResultEvents[0] as
    | Record<string, unknown>
    | undefined;
  const unavailableOutput = unavailableResultEvent?.output as
    | Record<string, unknown>
    | undefined;

  // --- 3. Stale late-completion: endpoint echoes wrong leaseToken ---
  const STALE_CAP = "az006.client.stale";
  const staleEndpoint = makeStaleEndpoint("ep-stale", STALE_CAP);
  const staleRun = await runTurn(STALE_CAP, [staleEndpoint]);
  const staleResultEvents = findAllEvents(staleRun.events, "tool.result");
  const staleResultEvent = staleResultEvents[0] as
    | Record<string, unknown>
    | undefined;
  const staleOutput = staleResultEvent?.output as
    | Record<string, unknown>
    | undefined;

  // --- 4. Client-side MCP binding classification ---
  const CLIENT_MCP_CAP = "az006.client.mcp";
  const clientMcpEndpoint = makeClientMcpEndpoint(
    "ep-mcp",
    CLIENT_MCP_CAP,
    "az006-mcp-server",
    { mcpConformanceResult: "ok" }
  );
  const mcpRun = await runTurn(CLIENT_MCP_CAP, [clientMcpEndpoint]);
  const mcpResultEvents = findAllEvents(mcpRun.events, "tool.result");
  const mcpAuditEvents = findAllEvents(mcpRun.events, "tool.audit");

  // Resolve the binding for the client-side MCP capability via the binding resolver
  const resolver = createBindingResolver();
  const mcpBinding = resolver.resolveFromToolDefinition({
    name: CLIENT_MCP_CAP,
    description: "client mcp",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve(undefined),
    metadata: { clientEndpointId: "ep-mcp", mcpServerName: "az006-mcp-server" },
  });

  return {
    result: {
      tuvrenClient: {
        normal: {
          status: normalRun.result.status,
          toolStartCount: normalStartEvents.length,
          toolResultCount: normalResultEvents.length,
          toolAuditCount: normalAuditEvents.length,
          toolResultIsError: normalResultEvent?.isError === true,
        },
        unavailable: {
          status: unavailableRun.result.status,
          toolResultIsError: unavailableResultEvent?.isError === true,
          toolResultOutputCode:
            typeof unavailableOutput?.code === "string"
              ? unavailableOutput.code
              : null,
        },
        stale: {
          toolResultIsError: staleResultEvent?.isError === true,
          toolResultOutputCode:
            typeof staleOutput?.code === "string" ? staleOutput.code : null,
          staleContentInResult:
            typeof staleOutput === "object" &&
            staleOutput !== null &&
            "staleContent" in staleOutput &&
            staleOutput.staleContent === true,
        },
        clientMcp: {
          status: mcpRun.result.status,
          toolResultCount: mcpResultEvents.length,
          toolAuditCount: mcpAuditEvents.length,
          bindingExecutionClass: mcpBinding.executionClass,
          bindingEndpointKind: mcpBinding.endpoint.kind,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.tuvren-client.network-reconnect-redelivery
//
// Network-evidence lane matching what M6's real-socket e2e proved for
// "Variant A" (typescript/host/repl/test/repl-serve-ws.e2e.test.ts): a socket
// dropped mid-dispatch (never `session.close()`) reconnects and redelivers
// the still-unanswered `client_invocation`, and a peer holding the callId
// "in-flight" in its own dedup table (exactly what `@tuvren/session-client`
// does) ignores the redelivery rather than re-running its capability
// handler — so exactly one side effect lands, keyed by one idempotencyKey,
// and no cursor is ever duplicated.
//
// Conformance adapters run in-process via the shared harness, so this
// operation cannot spawn a real OS process or a real WebSocket the way the
// M6 e2e does. It instead drives the strongest in-process-provable
// equivalent through the real binding -> session -> transport composition
// (`createDuplexSessionBinding` + `@tuvren/remote-session` +
// `@tuvren/stream-ws`'s `createWsSessionTransport`, the same composition the
// event-stream-ws adapter's `reconnect-with-cursor` operation already
// certifies): a simulated peer below implements the identical in-flight-
// callId dedup table `@tuvren/session-client` implements for real, and a
// simulated socket drop detaches (never closes) the session. The real
// cross-process, real-socket claim stays proven only by the package-test-only
// M6 e2e; this check proves the session-lifecycle mechanics the wire
// carriage rides on, honestly named for that scope.
// ---------------------------------------------------------------------------

interface NetworkPeerRecordingSink extends WsSocketSink {
  sent: Record<string, unknown>[];
}

function createNetworkPeerRecordingSink(
  onMessage: (message: Record<string, unknown>) => void
): NetworkPeerRecordingSink {
  const sent: Record<string, unknown>[] = [];
  return {
    close(): void {
      // No observable effect needed: the operation tracks session lifecycle
      // via `session.isEnded()`, not per-sink close bookkeeping.
    },
    send(data: string): void {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      sent.push(parsed);
      onMessage(parsed);
    },
    sent,
  };
}

const NETWORK_RECONNECT_SESSION_ID = "sess-az006-network-reconnect-1";
const NETWORK_RECONNECT_CAP = "az006.client.network-reconnect";

export async function runTuvrenClientNetworkReconnectRedelivery(): Promise<AdapterProjection> {
  const harness = createConformanceKernelHarness();
  const runner = makeSingleCallRunner(NETWORK_RECONNECT_CAP);
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});

  let bindingClientEndpoint: AttachedClientEndpoint | undefined;
  const deferredEndpoint: AttachedClientEndpoint = {
    advertisedCapabilities: [
      {
        capabilityId: NETWORK_RECONNECT_CAP,
        description:
          "az006 network-reconnect-redelivery conformance capability",
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      if (bindingClientEndpoint === undefined) {
        throw new Error(
          "az006 network-reconnect adapter dispatched a client invocation before the duplex session binding was wired"
        );
      }
      return bindingClientEndpoint.dispatch(envelope);
    },
    endpointId: "ep-az006-network-reconnect",
  };

  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [deferredEndpoint], name: AGENT_NAME },
    signal: textSignal("az006 network reconnect redelivery conformance"),
    threadId: thread.threadId,
  });
  const binding = createDuplexSessionBinding(handle, {
    sessionId: NETWORK_RECONNECT_SESSION_ID,
  });
  bindingClientEndpoint = binding.clientEndpoint;

  const session = createRemoteClientSession({
    binding,
    disconnectGraceMs: 30_000,
    dispatchTimeoutMs: 30_000,
    replayBufferCapacity: 200,
  });

  // The simulated peer's own in-memory dedup table — the exact mechanism
  // @tuvren/session-client uses in the real M6 socket e2e — so a redelivered
  // client_invocation for a callId already in flight is recognized and never
  // re-invokes the capability handler. The reply is deliberately withheld
  // until AFTER the redelivery has been observed on the second sink (mirrors
  // the real e2e's "gate" — the peer holds the call open across the drop),
  // otherwise the call would already be settled before the reconnect and
  // there would be nothing left to redeliver.
  const inFlightCallIds = new Set<string>();
  const idempotencyKeysSeen = new Set<string>();
  const invocationSightingCount = new Map<string, number>();
  // `effectCount` is observational only: it counts how many times THIS
  // ADAPTER's own `inFlightCallIds` dedup table (below) chose to run the
  // simulated peer's effect, which proves the adapter's own bookkeeping
  // works, not that the real implementation dedups. The real
  // implementation-side proof that a redelivered invocation is recognized
  // and not double-effected lives in `@tuvren/session-client`'s own package
  // tests (redelivery dedup: an already-answered callId re-sends the
  // recorded result without re-running the handler) and the M6 repl e2e
  // (`typescript/host/repl/test/repl-serve-ws.e2e.test.ts`), which drives a
  // real WebSocket peer across a genuine socket drop. This plan's
  // load-bearing assertions are `redeliveredInvocationCount`,
  // `idempotencyKeyCount`, `observedAtLeastOneCursor`, and
  // `noCursorDuplication` — all read from the session/session under test's
  // own outbound frames, not from this adapter's simulated peer.
  let effectCount = 0;
  let pendingReply: { callId: string; leaseToken: string } | undefined;
  let activeTransport: WsSessionTransport | undefined;

  function handlePeerMessage(message: Record<string, unknown>): void {
    if (message.kind !== "frame" || !isRecord(message.frame)) {
      return;
    }
    const frame = message.frame;
    if (frame.kind !== "client_invocation" || !isRecord(frame.invocation)) {
      return;
    }
    const invocation = frame.invocation;
    const callId = String(invocation.callId);
    invocationSightingCount.set(
      callId,
      (invocationSightingCount.get(callId) ?? 0) + 1
    );
    // Recorded for EVERY sighting — original and redelivery alike — so the
    // plan's single-key assertion proves the redelivered invocation carried
    // the same idempotency key as the original, not merely that the first
    // delivery carried one.
    if (typeof invocation.idempotencyKey === "string") {
      idempotencyKeysSeen.add(invocation.idempotencyKey);
    }

    if (inFlightCallIds.has(callId)) {
      return; // Redelivery of an already-in-flight call: dedup, no re-invoke.
    }
    inFlightCallIds.add(callId);
    effectCount += 1;
    pendingReply = { callId, leaseToken: String(invocation.leaseToken) };
  }

  function sendPendingReply(): void {
    if (pendingReply === undefined) {
      return;
    }
    const { callId, leaseToken } = pendingReply;
    pendingReply = undefined;
    activeTransport?.ingest(
      JSON.stringify({
        frame: {
          correlationId: `corr-${callId}`,
          kind: "client_result",
          protocolVersion: "1",
          result: {
            callId,
            content: { acknowledged: true },
            leaseToken,
          },
          sessionId: NETWORK_RECONNECT_SESSION_ID,
        },
        kind: "frame",
      })
    );
  }

  const firstSink = createNetworkPeerRecordingSink(handlePeerMessage);
  const firstTransport = createWsSessionTransport({
    session,
    sink: firstSink,
  });
  activeTransport = firstTransport;
  firstTransport.start();
  firstTransport.ingest(
    JSON.stringify({ kind: "handshake", protocolVersion: "1" })
  );

  await waitFor(() => inFlightCallIds.size >= 1);

  const firstFrames = firstSink.sent.filter(
    (message) => message.kind === "frame" && typeof message.cursor === "string"
  );
  const midCursor = firstFrames.at(-1)?.cursor as string | undefined;

  // Simulated socket drop, not session.close(): detaches this sink from the
  // still-alive session (ADR-063 decision 4). The reply is still withheld.
  firstTransport.close();

  const secondSink = createNetworkPeerRecordingSink(handlePeerMessage);
  const secondTransport = createWsSessionTransport({
    session,
    sink: secondSink,
  });
  activeTransport = secondTransport;
  secondTransport.start();
  secondTransport.ingest(
    JSON.stringify({
      cursor: midCursor,
      kind: "handshake",
      protocolVersion: "1",
    })
  );

  // Wait for the redelivery itself (a second sighting of the same callId)
  // before answering — this is the moment the M6 e2e observes as
  // `invocationSeen` staying at 1 despite the reconnect.
  await waitFor(() =>
    [...invocationSightingCount.values()].some((count) => count >= 2)
  );
  sendPendingReply();

  await waitFor(() => session.isEnded(), 10_000);

  const observedCursors = [...firstSink.sent, ...secondSink.sent]
    .filter(
      (message) =>
        message.kind === "frame" && typeof message.cursor === "string"
    )
    .map((message) => message.cursor as string);
  const redeliveredInvocationCount = secondSink.sent.filter(
    (message) =>
      message.kind === "frame" &&
      isRecord(message.frame) &&
      message.frame.kind === "client_invocation"
  ).length;

  const result = await handle.awaitResult();

  const observation = {
    effectCount,
    idempotencyKeyCount: idempotencyKeysSeen.size,
    noCursorDuplication:
      new Set(observedCursors).size === observedCursors.length,
    // Guards noCursorDuplication's vacuous-empty case (an empty set trivially
    // has no duplicates); the plan requires at least one cursor was observed.
    observedAtLeastOneCursor: observedCursors.length > 0,
    redeliveredInvocationCount,
    status: result.status,
  };

  return {
    result: { tuvrenClient: { networkReconnectRedelivery: observation } },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.tuvren-client.result-durability
//
// Network-evidence lane matching what M6's real e2e proved for "Variant B"
// (typescript/host/repl/test/repl-serve-ws.e2e.test.ts): a durably committed
// capability result survives independently of the process that wrote it. The
// real e2e proves this over a genuine `SIGKILL`'d subprocess and a
// PostgreSQL schema reopened by a fresh process; that stronger claim remains
// package-test-only evidence (it needs a spawned OS process and a
// persistent backend, neither available to the in-process conformance
// harness). This operation proves the same read-path durability claim
// in-process: a "writer" runtime commits a turn, and a completely separate
// "reader" runtime + kernel instance — sharing only the same in-memory
// backend object, never the writer's runtime/kernel/handle — reads the
// committed tool result back through the ordinary durable-read surface. No
// reference to the writer's runtime survives into the read.
// ---------------------------------------------------------------------------

const RESULT_DURABILITY_CAP = "az006.client.result-durability";

export async function runTuvrenClientResultDurability(): Promise<AdapterProjection> {
  const backend = createMemoryBackend();
  const writerKernel = createRuntimeKernel({ backend });
  const runner = makeSingleCallRunner(RESULT_DURABILITY_CAP);
  const writerRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: writerKernel,
  });
  const thread = await writerRuntime.createThread({});

  const idempotencyKeysSeen = new Set<string>();
  const endpoint: AttachedClientEndpoint = {
    advertisedCapabilities: [
      {
        capabilityId: RESULT_DURABILITY_CAP,
        description: "az006 result-durability conformance capability",
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      if (typeof envelope.idempotencyKey === "string") {
        idempotencyKeysSeen.add(envelope.idempotencyKey);
      }
      return Promise.resolve({
        callId: envelope.callId,
        content: { acknowledged: true },
        leaseToken: envelope.leaseToken,
      });
    },
    endpointId: "ep-az006-result-durability",
  };

  const handle = writerRuntime.executeTurn({
    branchId: thread.branchId,
    config: { clientEndpoints: [endpoint], name: AGENT_NAME },
    signal: textSignal("az006 network kill-durability conformance"),
    threadId: thread.threadId,
  });
  await collectValues(handle.events());
  const writerResult = await handle.awaitResult();

  // Simulated process death: no reference to writerRuntime/writerKernel/
  // handle is reused below. A brand-new kernel + runtime instance opens the
  // SAME backend object — the in-process analog of a fresh process
  // reopening the same durable schema.
  const readerKernel = createRuntimeKernel({ backend });
  const readerRuntime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: readerKernel,
  });
  const read = await readerRuntime.readBranchMessages({
    branchId: thread.branchId,
  });

  const toolMessages = read.messages.filter(
    (message) => isRecord(message) && message.role === "tool"
  );
  const committedPart = toolMessages
    .flatMap((message) => {
      const parts = isRecord(message) ? message.parts : undefined;
      return Array.isArray(parts) ? parts : [];
    })
    .find((part) => isRecord(part) && part.name === RESULT_DURABILITY_CAP);
  const hasCommittedResult = committedPart !== undefined;

  // `hasCommittedResult` alone only proves a part with the right name was
  // persisted, not that it survived as the SUCCESSFUL result the endpoint
  // actually returned — a durably-committed error result would satisfy it
  // just as well. `committedResultIsError` and `committedResultOutputEcho`
  // close that gap: they prove the specific `{ acknowledged: true }` payload
  // the endpoint's `dispatch` resolved with (see above) is the exact payload
  // read back from the separate reader runtime/kernel, not merely that
  // *some* result for this capability was committed.
  const committedResultIsError =
    isRecord(committedPart) && committedPart.isError === true;
  const committedOutput = isRecord(committedPart)
    ? committedPart.output
    : undefined;
  const committedResultOutputEcho =
    isRecord(committedOutput) && committedOutput.acknowledged === true;

  const observation = {
    committedResultIsError,
    committedResultOutputEcho,
    committedToolMessageCount: toolMessages.length,
    hasCommittedResult,
    idempotencyKeyPresent: [...idempotencyKeysSeen].some(
      (key) => key.length > 0
    ),
    writerStatus: writerResult.status,
  };

  return {
    result: { tuvrenClient: { networkKillDurability: observation } },
  };
}
