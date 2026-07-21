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
  type WsSessionTransport,
  type WsSocketSink,
} from "@tuvren/stream-ws";

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
   */
  resolve(sessionId: string | undefined): Promise<{
    entry: ReplWsSessionEntry;
    sessionId: string;
  }>;
  /** Observability only: the number of sessions this registry has ever created. */
  size(): number;
}

export function createReplWsSessionRegistry(
  options: ReplWsSessionRegistryOptions
): ReplWsSessionRegistry {
  const provider = options.provider ?? createServeWsDemoProvider();
  const entries = new Map<string, ReplWsSessionEntry>();

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

    const entry: ReplWsSessionEntry = {
      session: undefined as unknown as RemoteClientSession,
    };
    entry.session = createRemoteClientSession({
      binding,
      disconnectGraceMs: options.disconnectGraceMs,
      dispatchTimeoutMs: options.dispatchTimeoutMs,
      onEnded: () => {
        // ADR-063/spec/streaming/ws/bindings/typescript.md host obligation:
        // wire onEnded to close whichever transport currently owns this
        // session with the normal-closure code, then release the registry
        // slot so a later handshake for the same sessionId mints a fresh
        // turn rather than resurrecting a dead session.
        entry.currentTransport?.close(1000, "session ended");
        entries.delete(sessionId);
      },
      replayBufferCapacity: options.replayBufferCapacity,
    });

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
          return { entry: existing, sessionId: requestedSessionId };
        }
      }

      const sessionId = requestedSessionId ?? randomUUID();
      const entry = await createEntry(sessionId);
      entries.set(sessionId, entry);
      return { entry, sessionId };
    },
    size(): number {
      return entries.size;
    },
  };
}

/** Best-effort extraction of a handshake's `sessionId`, without full frame validation (the transport itself re-validates on ingest). */
export function peekHandshakeSessionId(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sessionId" in parsed &&
      typeof (parsed as { sessionId?: unknown }).sessionId === "string"
    ) {
      return (parsed as { sessionId: string }).sessionId;
    }
  } catch {
    // Malformed JSON: let the transport's own parseWsMessage/session_rejection
    // path handle it once ingested rather than duplicating that diagnosis here.
  }
  return undefined;
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
    ws: { data: ReplWsConnectionState } & {
      send(data: string): void;
      close(code?: number, reason?: string): void;
      bufferedAmount?: number;
    },
    text: string
  ): Promise<void> {
    const requestedSessionId = peekHandshakeSessionId(text);
    // sessionId itself is not needed here: the transport's own handshake_ack
    // already carries it back to the peer, and `entry` is all this function
    // needs to compose the transport.
    const { entry } = await registry.resolve(requestedSessionId);

    const sink: WsSocketSink = {
      bufferedAmount(): number {
        return ws.bufferedAmount ?? 0;
      },
      close(code, reason) {
        ws.close(code, reason);
      },
      send(data) {
        ws.send(data);
      },
    };

    const transport = createWsSessionTransport({
      ...(options.heartbeat === undefined
        ? {}
        : { heartbeat: options.heartbeat }),
      session: entry.session,
      sink,
    });

    ws.data.transport = transport;
    entry.currentTransport = transport;
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
          handleFirstMessage(
            ws as unknown as {
              data: ReplWsConnectionState;
              send(data: string): void;
              close(code?: number, reason?: string): void;
              bufferedAmount?: number;
            },
            text
          ).catch((error: unknown) => {
            ws.close(
              1011,
              `internal error handling handshake: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
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
