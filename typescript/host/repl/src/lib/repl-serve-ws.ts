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
 * The REPL host's first real network surface (M6, issue #102): a
 * `Bun.serve` WebSocket mode that composes the full duplex-chain stack —
 * `DuplexSessionBinding` (`@tuvren/host-session`) -> `RemoteClientSession`
 * (`@tuvren/remote-session`) -> `createWsSessionTransport`
 * (`@tuvren/stream-ws`) -> a real `Bun.serve` websocket — over the REPL
 * host's existing runtime/kernel/backend wiring (`repl-host.ts`).
 *
 * This module is deliberately a demonstration host, not a production
 * gateway: one hardcoded demo turn per new session, a single demo
 * `tuvren-client` capability, and a scripted provider so the whole chain can
 * be driven and proven without a live model. Host obligations wired here per
 * `spec/host/client-endpoint-integration.md` and
 * `spec/streaming/ws/bindings/typescript.md`:
 *
 * - a `sessionId -> RemoteClientSession` registry is host state (ADR-063
 *   consequences) — this module owns it;
 * - `RemoteClientSessionOptions.onEnded` is wired to close whichever
 *   transport is currently attached with code `1000`, then the registry
 *   entry is dropped;
 * - a `tuvren-client` capability (`DEMO_CLIENT_CAPABILITY_ID`) is advertised
 *   on `AgentConfig.clientEndpoints` so the model can dispatch to the remote
 *   peer.
 *
 * Recorded limitations (demo scope, not fixed here):
 *
 * (a) **Reconnect-vs-close race is refused, not retried.** A reconnect whose
 *     handshake races this host's processing of the *prior* socket's close
 *     for the same `sessionId` can observe `entry.session` still attached
 *     (the old transport has not yet `detach()`-ed) and be refused with
 *     `WS_CLOSE_CODE_HANDSHAKE_INVALID` (`4000`) — a close code the
 *     reference `@tuvren/session-client` treats as non-retryable
 *     (`isRetryableCloseCode`), so that peer gives up rather than backing off
 *     and trying again. This is localhost-timing-dependent and acceptable
 *     for a demo host; a production host would serialize handshake
 *     processing per `sessionId` (so a reconnect never observes the stale
 *     attach) or map a busy-refusal outcome to a retryable close code
 *     instead of reusing `4000`.
 * (b) **Ended-session identity shadowing.** Once a session has permanently
 *     ended (`onEnded` fired, entry removed), a later handshake presenting
 *     that same `sessionId` is indistinguishable from a genuinely unknown
 *     id to `createReplWsSessionRegistry.resolve` — it mints a *fresh* demo
 *     turn under the old identity rather than closing with
 *     `WS_CLOSE_CODE_SESSION_NOT_FOUND`. This is intentional for the demo
 *     (no persistent record of "this id existed and ended" is kept), with a
 *     named consequence: a peer that reconnects with a stale resume cursor
 *     from the ended session resolves that cursor against the *new*
 *     session's empty replay buffer, not the old one — `attach()` reports
 *     `"unknown-turn"` or `"out-of-window"` rather than anything describing
 *     the identity shadowing.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import type {
  AttachedClientEndpoint,
  ClientEndpointCapabilityAdvertisement,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import { createDuplexSessionBinding } from "@tuvren/host-session";
import {
  createRemoteClientSession,
  type RemoteClientSession,
} from "@tuvren/remote-session";
import type {
  ProviderStreamChunk,
  TuvrenModelResponse,
  TuvrenPrompt,
  TuvrenProvider,
  TuvrenRuntime,
} from "@tuvren/sdk";
import {
  createWsSessionTransport,
  parseWsMessage,
  WS_CLOSE_CODE_HANDSHAKE_INVALID,
  WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED,
  type WsSessionTransport,
  type WsSocketSink,
} from "@tuvren/stream-ws";

const HANDSHAKE_SUPPORTED_PROTOCOL_VERSION = "1";

/**
 * Stable identifier of the demonstration `tuvren-client` capability
 * `--serve-ws` advertises on every session's turn. A real host would
 * advertise capabilities specific to its remote peer population instead.
 */
export const DEMO_CLIENT_CAPABILITY_ID = "tuvren-client.demo" as const;

/**
 * Deferred client endpoint that breaks the `executeTurn` <-> `ExecutionHandle`
 * <-> `DuplexSessionBinding` construction cycle.
 *
 * Adapted with attribution from
 * `typescript/conformance-adapter/src/framework-adapter-session.ts`'s
 * `createDeferredClientEndpoint` (issue #99 conformance adapter): `runtime.executeTurn()`
 * reads `config.clientEndpoints` synchronously, so the real
 * `AttachedClientEndpoint` the binding owns cannot exist yet at the point
 * `executeTurn` is called. This stub is handed to `executeTurn` up front, and
 * `setDelegate` wires it to `binding.clientEndpoint` immediately afterward, in
 * the same synchronous tick — before the runtime's lazy-start contract lets
 * anything pull the runner far enough to dispatch a capability call.
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
          "repl --serve-ws dispatched a client invocation before the duplex session binding was wired"
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

/**
 * A scripted `TuvrenProvider` for `--serve-ws` demo turns: on the first
 * model call it requests the demo `tuvren-client` capability exactly once;
 * once a `tool` role message reporting that call's result is present in the
 * prompt, it produces a final text response and ends the turn. This lets the
 * end-to-end proof drive a real client-capability dispatch over the wire
 * without depending on a live model provider.
 */
export function createServeWsDemoProvider(): TuvrenProvider {
  function respond(prompt: TuvrenPrompt): TuvrenModelResponse {
    const hasToolResult = prompt.messages.some(
      (message) => message.role === "tool"
    );

    if (hasToolResult) {
      return {
        finishReason: "stop",
        parts: [
          {
            text: "tuvren-client demo capability call complete.",
            type: "text",
          },
        ],
        usage: { inputTokens: 8, outputTokens: 6 },
      };
    }

    return {
      finishReason: "tool_call",
      parts: [
        {
          callId: "demo-call-1",
          input: { demo: true },
          name: DEMO_CLIENT_CAPABILITY_ID,
          type: "tool_call",
        },
      ],
    };
  }

  return {
    generate(prompt) {
      return Promise.resolve(respond(prompt));
    },
    id: "repl:serve-ws:demo",
    async *stream(prompt) {
      await Promise.resolve();
      const response = respond(prompt);

      for (const part of response.parts) {
        if (part.type === "text") {
          yield {
            text: part.text,
            type: "text_delta",
          } satisfies ProviderStreamChunk;
        } else if (part.type === "tool_call") {
          yield {
            name: part.name,
            providerCallId: part.callId,
            type: "tool_call_start",
          } satisfies ProviderStreamChunk;
          yield {
            delta: JSON.stringify(part.input),
            providerCallId: part.callId,
            type: "tool_call_args_delta",
          } satisfies ProviderStreamChunk;
          yield {
            input: part.input,
            name: part.name,
            providerCallId: part.callId,
            type: "tool_call_done",
          } satisfies ProviderStreamChunk;
        }
      }

      yield {
        finishReason: response.finishReason,
        type: "finish",
        usage: response.usage,
      } satisfies ProviderStreamChunk;
    },
  };
}

/** One registry entry: the reattachable session plus whichever transport currently owns it. */
interface ReplWsSessionEntry {
  currentTransport?: WsSessionTransport;
  session: RemoteClientSession;
}

/** Observability record emitted once per freshly created demo turn. */
export interface ReplWsSessionCreatedInfo {
  branchId: string;
  sessionId: string;
  threadId: string;
}

/** Options accepted by {@link createReplWsSessionRegistry}. */
export interface ReplWsSessionRegistryOptions {
  /** How long a detached session waits for a reattach (ADR-063 decision 4). */
  disconnectGraceMs: number;
  /** How long a dispatched client_invocation may go unanswered while attached (ADR-063 decision 5). */
  dispatchTimeoutMs: number;
  /**
   * Observability hook invoked once per freshly created demo turn (never on
   * a reattach to an existing entry). Lets a harness/test recover the
   * `threadId`/`branchId` backing a given `sessionId` without the wire
   * protocol needing to carry that host-internal detail.
   */
  onSessionCreated?: (info: ReplWsSessionCreatedInfo) => void;
  /** Provider driving each session's single demo turn. Defaults to {@link createServeWsDemoProvider}. */
  provider?: TuvrenProvider;
  /** Capacity of each session's replay window (ADR-061). */
  replayBufferCapacity: number;
  /** The runtime backing every session's demo turn. */
  runtime: TuvrenRuntime;
  /** System prompt for each session's demo turn. */
  systemPrompt?: string;
}

/**
 * Host-owned `sessionId -> RemoteClientSession` registry (ADR-063
 * consequences): the state a `--serve-ws` process must keep so a reconnect
 * with a known `sessionId` can reattach to the *same* session rather than
 * starting a new turn.
 *
 * @experimental
 */
export interface ReplWsSessionRegistry {
  /**
   * Resolves the entry for `sessionId`, creating a fresh demo turn (new
   * thread, new binding, new session) when the id is unknown to this
   * registry. Returns the existing entry — attached, detached, or
   * permanently ended — for a known id, so the transport's own
   * `session.attach()` call decides the reattach/refusal outcome.
   *
   * `created` is `true` only for the caller whose invocation actually ran
   * {@link createEntry} for this `sessionId` — never for a concurrent second
   * caller that merely awaited the same in-flight creation (P2-4), and never
   * for a caller that reused a pre-existing entry. Callers use this to scope
   * cleanup narrowly: only the connection that minted a brand-new entry may
   * ever tear it down on a failed handshake (P2-2); a connection that only
   * observed a pre-existing entry must never do so.
   */
  resolve(sessionId: string | undefined): Promise<{
    created: boolean;
    entry: ReplWsSessionEntry;
    sessionId: string;
  }>;
  /** Observability only: the number of currently live sessions (entries are removed again when a session ends). */
  size(): number;
}

export function createReplWsSessionRegistry(
  options: ReplWsSessionRegistryOptions
): ReplWsSessionRegistry {
  const provider = options.provider ?? createServeWsDemoProvider();
  const entries = new Map<string, ReplWsSessionEntry>();
  // P2-4: two sockets presenting the same unknown sessionId can both pass
  // the `entries.get` miss above before the first caller's async
  // `createEntry` finishes. Tracking the in-flight creation promise here
  // means the second caller awaits and reuses the first caller's entry
  // instead of racing it into creating a second, orphaned one.
  const pendingCreations = new Map<string, Promise<ReplWsSessionEntry>>();

  async function createEntry(sessionId: string): Promise<ReplWsSessionEntry> {
    const thread = await options.runtime.createThread({});
    const deferredEndpoint = createDeferredClientEndpoint(
      `repl-serve-ws:${sessionId}`,
      [
        {
          capabilityId: DEMO_CLIENT_CAPABILITY_ID,
          description:
            "Demonstration tuvren-client capability dispatched to the connected WebSocket peer.",
          inputSchema: { type: "object" },
        },
      ]
    );

    const handle = options.runtime.executeTurn({
      branchId: thread.branchId,
      config: {
        clientEndpoints: [deferredEndpoint],
        model: provider,
        name: "repl-serve-ws-demo",
        systemPrompt: options.systemPrompt,
      },
      signal: {
        parts: [
          { text: "Dispatch the tuvren-client demo capability.", type: "text" },
        ],
      },
      threadId: thread.threadId,
    });

    const binding = createDuplexSessionBinding(handle, { sessionId });
    deferredEndpoint.setDelegate(binding.clientEndpoint);

    // The session must exist before the entry (its `onEnded` callback needs
    // to close whichever transport currently owns the entry), so the mutable
    // `currentTransport` slot is held in this closure-local `let` binding
    // first and the entry object below merely exposes it as an accessor
    // property — no placeholder/undefined cast stands in for `session`.
    let currentTransport: WsSessionTransport | undefined;
    const session = createRemoteClientSession({
      binding,
      disconnectGraceMs: options.disconnectGraceMs,
      dispatchTimeoutMs: options.dispatchTimeoutMs,
      onEnded: () => {
        // ADR-063/spec/streaming/ws/bindings/typescript.md host obligation:
        // wire onEnded to close whichever transport currently owns this
        // session with the normal-closure code, then release the registry
        // slot so a later handshake for the same sessionId mints a fresh
        // turn rather than resurrecting a dead session.
        currentTransport?.close(1000, "session ended");
        entries.delete(sessionId);
      },
      replayBufferCapacity: options.replayBufferCapacity,
    });

    const entry: ReplWsSessionEntry = {
      get currentTransport(): WsSessionTransport | undefined {
        return currentTransport;
      },
      set currentTransport(value: WsSessionTransport | undefined) {
        currentTransport = value;
      },
      session,
    };

    options.onSessionCreated?.({
      branchId: thread.branchId,
      sessionId,
      threadId: thread.threadId,
    });

    return entry;
  }

  return {
    async resolve(requestedSessionId) {
      if (requestedSessionId !== undefined) {
        const existing = entries.get(requestedSessionId);
        if (existing !== undefined) {
          return {
            created: false,
            entry: existing,
            sessionId: requestedSessionId,
          };
        }

        const inFlight = pendingCreations.get(requestedSessionId);
        if (inFlight !== undefined) {
          const entry = await inFlight;
          return { created: false, entry, sessionId: requestedSessionId };
        }
      }

      const sessionId = requestedSessionId ?? randomUUID();
      const creation = createEntry(sessionId).then((entry) => {
        entries.set(sessionId, entry);
        return entry;
      });
      pendingCreations.set(sessionId, creation);
      try {
        const entry = await creation;
        return { created: true, entry, sessionId };
      } finally {
        pendingCreations.delete(sessionId);
      }
    },
    size(): number {
      return entries.size;
    },
  };
}

/** Options accepted by {@link startReplWsServer}. */
export interface ReplWsServerOptions {
  /** How long a detached session waits for a reattach. Defaults to `5000`. */
  disconnectGraceMs?: number;
  /** How long a dispatched client_invocation may go unanswered while attached. Defaults to `10000`. */
  dispatchTimeoutMs?: number;
  /** Heartbeat tuning passed through to every transport. Omit to disable heartbeat. */
  heartbeat?: { intervalMs: number; timeoutMs: number };
  /** Hostname to bind. Defaults to `"127.0.0.1"`. */
  hostname?: string;
  /** Forwarded to {@link ReplWsSessionRegistryOptions.onSessionCreated}. */
  onSessionCreated?: (info: ReplWsSessionCreatedInfo) => void;
  /** TCP port to bind. `0` picks an ephemeral port (read back from the returned server). */
  port?: number;
  /** Overrides the demo turn's provider. Defaults to {@link createServeWsDemoProvider}. */
  provider?: TuvrenProvider;
  /** Capacity of each session's replay window. Defaults to `256`. */
  replayBufferCapacity?: number;
  /** The runtime backing every session's demo turn. */
  runtime: TuvrenRuntime;
  /** System prompt for each session's demo turn. */
  systemPrompt?: string;
}

/** A running `--serve-ws` demo server. */
export interface ReplWsServer {
  /** The bound port (resolved even when `options.port` was `0`). */
  readonly port: number;
  /** The registry backing every session this server has created. */
  readonly registry: ReplWsSessionRegistry;
  /** Stops accepting new connections and closes every live socket. */
  stop(): Promise<void>;
  /** The `ws://` base URL this server is listening on. */
  readonly url: string;
}

interface ReplWsConnectionState {
  transport?: WsSessionTransport;
}

/**
 * The structural subset of Bun's `ServerWebSocket<ReplWsConnectionState>`
 * this module actually uses: enough to run the handshake path and hand a
 * sink to `createWsSessionTransport`. Named once and shared by both call
 * sites in this file (the `handleFirstMessage` parameter and the raw
 * `websocket.message` handler below) instead of repeating the same inline
 * structural type twice.
 */
interface ServeWsSocket {
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  data: ReplWsConnectionState;
  send(data: string): void;
}

/**
 * Starts the REPL host's `--serve-ws` demo server: `Bun.serve` websocket
 * handlers composing `binding -> session -> transport -> socket`
 * (`spec/streaming/ws/bindings/typescript.md`).
 *
 * @experimental
 */
export function startReplWsServer(options: ReplWsServerOptions): ReplWsServer {
  const registry = createReplWsSessionRegistry({
    disconnectGraceMs: options.disconnectGraceMs ?? 5000,
    dispatchTimeoutMs: options.dispatchTimeoutMs ?? 10_000,
    onSessionCreated: options.onSessionCreated,
    provider: options.provider,
    replayBufferCapacity: options.replayBufferCapacity ?? 256,
    runtime: options.runtime,
    systemPrompt: options.systemPrompt,
  });

  async function handleFirstMessage(
    ws: ServeWsSocket,
    text: string
  ): Promise<void> {
    // P2-2: validate the handshake's own shape — `kind === "handshake"` and a
    // supported `protocolVersion` — BEFORE ever touching the registry. A
    // garbage or protocol-mismatched first message must never allocate a
    // registry entry (thread + turn + binding): there would be nothing left
    // to clean it up, since no transport ever gets far enough to attach and
    // no later message on this closed socket will arrive to trigger it. This
    // mirrors exactly what `createWsSessionTransport`'s own
    // `processHandshake` validates and closes with, so behavior for a valid
    // handshake is unchanged — only the ordering (validate, then allocate)
    // is new.
    const parsed = parseWsMessage(text);

    if (parsed.kind !== "handshake") {
      ws.close(
        WS_CLOSE_CODE_HANDSHAKE_INVALID,
        "first message on a WebSocket session transport must be a handshake"
      );
      return;
    }

    if (
      parsed.message.protocolVersion !== HANDSHAKE_SUPPORTED_PROTOCOL_VERSION
    ) {
      ws.close(
        WS_CLOSE_CODE_PROTOCOL_VERSION_UNSUPPORTED,
        `unsupported handshake protocolVersion "${parsed.message.protocolVersion}"`
      );
      return;
    }

    // Only a structurally plausible handshake reaches registry allocation.
    // `created` scopes the failed-handshake cleanup below to entries THIS
    // connection minted — never a pre-existing entry another connection
    // still owns (P2-2, P2-4).
    const { created, entry } = await registry.resolve(parsed.message.sessionId);

    // P2-3: `entry.currentTransport` must only ever point at a transport
    // whose handshake actually attached — never a refused newcomer, so that
    // `onEnded`'s `entry.currentTransport?.close(...)` always closes the
    // transport that actually owns the attached sink. `createWsSessionTransport`
    // exposes no attach-succeeded callback, so this transport's own
    // `handshake_ack` — sent from inside `attachToSession` only after
    // `session.attach()` has already succeeded — is the seam: observing that
    // exact frame on its way out is the attach-succeeded signal.
    let transport: WsSessionTransport | undefined;
    let ackObserved = false;

    const sink: WsSocketSink = {
      bufferedAmount(): number {
        return ws.bufferedAmount ?? 0;
      },
      close(code, reason) {
        // P2-2: a close observed before this connection's own handshake_ack
        // ever went out means this transport's attach never succeeded. If
        // this connection is also the one that just minted a brand-new
        // registry entry (created === true), that entry now has no attached
        // transport and never will — tear it down (session.close(), which
        // drives the registry's own onEnded cleanup) rather than leak a
        // permanent thread + turn + binding. Never do this for an entry this
        // connection did not create: a refused concurrent second attach on
        // an existing, still-live session must leave that session alone.
        if (!ackObserved && created) {
          entry.session.close(
            "handshake failed before this newly created session ever attached"
          );
        }
        ws.close(code, reason);
      },
      send(data) {
        if (!ackObserved && isHandshakeAckFrame(data)) {
          ackObserved = true;
          entry.currentTransport = transport;
        }
        ws.send(data);
      },
    };

    transport = createWsSessionTransport({
      ...(options.heartbeat === undefined
        ? {}
        : { heartbeat: options.heartbeat }),
      session: entry.session,
      sink,
    });

    ws.data.transport = transport;
    transport.start();
    transport.ingest(text);
  }

  // biome-ignore lint/correctness/noUndeclaredVariables: Bun global — this REPL host runs on the Bun runtime (CLAUDE.md: "Bun APIs are fine here").
  const server = Bun.serve<ReplWsConnectionState>({
    fetch(req, srv) {
      const upgraded = srv.upgrade(req, { data: { transport: undefined } });
      if (upgraded) {
        return;
      }
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    websocket: {
      close(ws) {
        ws.data.transport?.close(1000, "socket closed");
      },
      message(ws, message) {
        const text =
          typeof message === "string"
            ? message
            : Buffer.from(message).toString("utf8");

        if (ws.data.transport === undefined) {
          // Fire-and-forget: the handshake's async session resolution has no
          // caller waiting on it — subsequent inbound messages queue up as
          // ordinary websocket message events and are handled once
          // ws.data.transport is set. A failure here has nowhere useful to
          // propagate to but the socket itself.
          handleFirstMessage(ws as ServeWsSocket, text).catch(
            (error: unknown) => {
              ws.close(
                1011,
                `internal error handling handshake: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          );
          return;
        }

        ws.data.transport.ingest(text);
      },
    },
  });

  const boundPort = server.port ?? 0;

  return {
    port: boundPort,
    registry,
    async stop(): Promise<void> {
      await server.stop(true);
    },
    url: `ws://${options.hostname ?? "127.0.0.1"}:${boundPort}`,
  };
}

/**
 * Structural check for the exact `handshake_ack` frame
 * `createWsSessionTransport`'s `attachToSession` sends immediately after a
 * successful `session.attach()` — the attach-succeeded signal
 * {@link startReplWsServer}'s sink wrapper uses (P2-3), since the transport
 * itself exposes no dedicated success callback. Deliberately loose (only the
 * `kind` discriminator): this is an internal observation of an outbound frame
 * this same module's own transport call produced, not an untrusted inbound
 * payload needing full structural validation.
 */
function isHandshakeAckFrame(data: string): boolean {
  try {
    const value: unknown = JSON.parse(data);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { kind?: unknown }).kind === "handshake_ack"
    );
  } catch {
    return false;
  }
}
