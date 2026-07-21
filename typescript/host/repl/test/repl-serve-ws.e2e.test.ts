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
 * End-to-end proof for the REPL host's `--serve-ws` mode (M6, issue #102):
 * a REAL `Bun.serve` server, spawned as a REAL child process, driven over a
 * genuine WebSocket by an in-process `@tuvren/session-client` peer.
 *
 * Backend note: this test drives the server subprocess and (for variant B)
 * a direct post-kill read against the PostgreSQL backend, not SQLite. The
 * SQLite backend's `better-sqlite3` native binding does not load under the
 * Bun runtime (`bun src/cli.ts` / `bun test` both fail with "'better-sqlite3'
 * is not yet supported in Bun" — the repo's own `scenario-sqlite` Nx target
 * only ever exercises it via `node dist/cli.js`). PostgreSQL's `postgres`
 * driver is pure TypeScript and runs fine under Bun, so it is the only
 * backend this Bun-native end-to-end test can exercise directly, in both the
 * spawned server subprocess and this test's own post-kill verification.
 * Every allocated schema is a disposable, randomly-named schema dropped in
 * `afterAll`, per the repo's disposable-state test convention; devenv's
 * PostgreSQL service is assumed already running (CLAUDE.md: do not run
 * `devenv up` / `services:up` from within a test).
 *
 * This test proves two variants, not the single "kill -9 the server and
 * resume the exact same in-flight redelivery loop" scenario the milestone
 * text opens with — see below for why that stronger claim is not honestly
 * provable with this runtime today, and which ADR-065 obligation is the
 * blocker.
 *
 * Variant A (fully proven): reconnect-redelivery, restructured so redelivery
 * is LOAD-BEARING for completion (M6 review P1-1) rather than incidental. A
 * prior version of this test killed the raw socket while the capability
 * handler was still in-flight; every assertion it made held even with the
 * server's redelivery loop deleted entirely, because the client's own
 * "in-flight" dedup entry (see `handleInvocation` in
 * `@tuvren/session-client`) suppresses a redelivered invocation on its own,
 * with no dependency on the server ever redelivering anything.
 *
 * This version instead lets the peer's handler fully ANSWER the invocation
 * — `settle()` records the result and calls `sendClientResult` — and
 * intercepts that specific outbound `client_result` websocket frame via a
 * wrapped `webSocketFactory`: the wrapper drops the frame's bytes (the
 * server never receives it) and, in the same call, closes the *raw* socket
 * to force a real reconnect. The server's `RemoteClientSession` never
 * observed a settling `client_result`, so its `pendingInvocations` entry for
 * that `callId` survives the reconnect untouched; on reattach it redelivers
 * the still-unanswered `client_invocation` (ADR-063 decision 3). The peer's
 * `callState` for that `callId` is now `"answered"` (the handler already
 * ran), so `handleInvocation` takes the redelivery branch that RE-SENDS the
 * recorded result rather than re-running the handler — and this time the
 * wrapper forwards it, since only the first `client_result` send is ever
 * dropped. The turn can therefore only reach `message.done` if the server's
 * redelivery actually fired: with the redelivery loop deleted, the dropped
 * result is gone forever, the server's dispatch never settles inside this
 * test's short post-reattach window, and the turn never completes — making
 * completion a genuine function of redelivery having happened, not an
 * artifact of client-side dedup.
 *
 * The wrapper also counts `client_invocation` frames at the raw-socket level
 * (before any of the peer's own dedup logic runs), across both the original
 * and the reattached connection, and records each one's `callId` — the
 * positive, direct proof that the SAME call was actually redelivered over
 * the wire (expected count: 2, both instances naming the same `callId`),
 * rather than inferring redelivery only from the absence of a second
 * handler execution.
 *
 * Variant B (honest, weaker): resume-from-committed-head across a real
 * process kill. A second session runs its demo turn to completion on the
 * same server process; the server process is then SIGKILL'd. The test opens
 * a fresh runtime directly against the same durable PostgreSQL schema (a
 * genuine new process reading state the killed process last committed) and
 * asserts the committed capability result survived intact. It does NOT
 * attempt to reconnect that sessionId to a newly spawned server and assert
 * "resumed": `RemoteClientSession`/replay-buffer state is in-memory and
 * process-local (ADR-063), so a new server process treats an unknown
 * sessionId as a fresh turn, and cold recovery of an in-flight turn
 * re-invokes the model and mints a fresh callId rather than re-presenting
 * the staged result — ADR-065 obligation 1
 * (`typescript/runtime/src/lib/idempotency-identity.ts`'s own doc comment,
 * "Recovery re-presents [callId] from committed or staged state", describes
 * the target design; staged-result re-presentation across a cold restart is
 * the still-open half of that). Asserting dedup-by-idempotencyKey across
 * THAT boundary today would be fabricated evidence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createPostgresBackend } from "@tuvren/backend-postgres";
import { createReActRunner, REACT_RUNNER_ID } from "@tuvren/runner-react";
import {
  createRunnerRegistry,
  createRuntimeKernel,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/sdk/advanced";
import {
  createSessionClient,
  type SessionClientSocket,
  type SessionClientStatus,
} from "@tuvren/session-client";
import postgres from "postgres";
import { DEMO_CLIENT_CAPABILITY_ID } from "../src/lib/repl-serve-ws.js";

const REPL_ROOT = join(import.meta.dir, "..");
const POSTGRES_DATABASE = "tuvren_runtime";

interface ServerHandle {
  effectsLogPath: string;
  kill(): Promise<void>;
  proc: ReturnType<typeof Bun.spawn>;
  sessionsCreated: Array<{
    branchId: string;
    sessionId: string;
    threadId: string;
  }>;
  url: string;
}

function requiredPostgresEnv(): {
  host: string;
  port: number;
  username: string;
} {
  const host = process.env.PGHOST;
  const portValue = process.env.PGPORT;
  const username = process.env.PGUSER ?? process.env.USER;

  if (host === undefined || host.length === 0) {
    throw new Error(
      "PGHOST is missing. Load the repo environment with direnv and start PostgreSQL with `devenv up -d` before running this test."
    );
  }
  if (portValue === undefined || portValue.length === 0) {
    throw new Error(
      "PGPORT is missing; load the repo environment with direnv."
    );
  }
  if (username === undefined || username.length === 0) {
    throw new Error(
      "PGUSER (or $USER) is missing; load the repo environment with direnv."
    );
  }

  return { host, port: Number.parseInt(portValue, 10), username };
}

async function startServer(schemaName: string): Promise<ServerHandle> {
  const effectsLogPath = join(
    tmpdir(),
    `ws-peer-effects-${crypto.randomUUID()}.ndjson`
  );
  const pg = requiredPostgresEnv();

  // biome-ignore lint/correctness/noUndeclaredVariables: Bun global (this test drives a real Bun subprocess).
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "src/cli.ts",
      "--serve-ws",
      "--serve-ws-port",
      "0",
      "--backend",
      "postgres",
      "--postgres-database",
      POSTGRES_DATABASE,
      "--postgres-schema",
      schemaName,
    ],
    cwd: REPL_ROOT,
    // A minimal, explicit env rather than the full inherited `process.env`:
    // this repo's direnv/devenv session sets several very large variables
    // (e.g. `DIRENV_DIFF`) that, combined with the rest of the inherited
    // environment, can overflow `posix_spawn`'s argument/environment buffer
    // (observed as a spurious `E2BIG` from Bun.spawn) — unrelated to this
    // test's own argv, which is tiny. `--serve-ws` needs nothing from the
    // ambient dev environment beyond a working `PATH` and the PostgreSQL
    // connection variables devenv already exported.
    env: {
      PATH: process.env.PATH ?? "",
      PGHOST: pg.host,
      PGPORT: String(pg.port),
      PGUSER: pg.username,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const sessionsCreated: Array<{
    branchId: string;
    sessionId: string;
    threadId: string;
  }> = [];

  // P2-5: from here on, any failure (the "listening" line never arriving,
  // JSON.parse throwing on a malformed line, the reader itself rejecting)
  // must not leave this already-spawned child process orphaned — kill it
  // before rethrowing rather than only relying on `afterAll`'s best-effort
  // `server?.kill()`, which never runs if `startServer` itself never
  // resolves into `server` (see `beforeAll` below).
  try {
    let resolveListening: ((url: string) => void) | undefined;
    const listening = new Promise<string>((resolve) => {
      resolveListening = resolve;
    });

    (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (line.trim().length === 0) {
            continue;
          }
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed) && parsed.kind === "listening") {
            resolveListening?.(String(parsed.url));
          } else if (isRecord(parsed) && parsed.kind === "session-created") {
            sessionsCreated.push({
              branchId: String(parsed.branchId),
              sessionId: String(parsed.sessionId),
              threadId: String(parsed.threadId),
            });
          }
        }
      }
    })().catch(() => undefined);

    const url = await Promise.race([
      listening,
      new Promise<string>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                "--serve-ws subprocess did not report listening in time"
              )
            ),
          20_000
        );
      }),
    ]);

    return {
      effectsLogPath,
      async kill(): Promise<void> {
        proc.kill("SIGKILL");
        await proc.exited;
      },
      proc,
      sessionsCreated,
      url,
    };
  } catch (error) {
    proc.kill("SIGKILL");
    await proc.exited.catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Structural peek at a wire text frame's `{kind: "frame", frame: {...}}`
 * envelope (`@tuvren/stream-ws`'s `WsOutboundFrameEnvelope`/`WsInboundFrameEnvelope`),
 * used only by variant A's raw-socket wrapper to detect the specific
 * `client_result` frame to drop and every `client_invocation` frame that
 * arrives (original delivery and redelivery alike). Never throws — malformed
 * or unrelated frames (handshake_ack, ping/pong, event frames) simply report
 * `kind: undefined`.
 */
function parseSessionFrameText(text: string): {
  kind: "client_result" | "client_invocation" | undefined;
  callId?: string;
} {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      parsed.kind !== "frame" ||
      !isRecord(parsed.frame)
    ) {
      return { kind: undefined };
    }
    const inner = parsed.frame;

    if (inner.kind === "client_result" && isRecord(inner.result)) {
      const callId = inner.result.callId;
      return {
        callId: typeof callId === "string" ? callId : undefined,
        kind: "client_result",
      };
    }

    if (inner.kind === "client_invocation" && isRecord(inner.invocation)) {
      const callId = inner.invocation.callId;
      return {
        callId: typeof callId === "string" ? callId : undefined,
        kind: "client_invocation",
      };
    }

    return { kind: undefined };
  } catch {
    return { kind: undefined };
  }
}

/**
 * Whether `event` is the demo turn's final `message.done` (the assistant's
 * closing text response, `finishReason: "stop"`, after the capability
 * result has been folded back in). Used instead of a `turn.end` event: this
 * repl-serve-ws demo turn's `RemoteClientSession` ends (and the socket
 * closes with code `1000`) essentially concurrently with the handle's event
 * stream itself completing, so this test observes the last assistant
 * message settling rather than racing the socket close against a
 * `turn.end` frame that may not have flushed before the connection drops.
 */
function isFinalAssistantMessageDone(event: unknown): boolean {
  return (
    isRecord(event) &&
    event.type === "message.done" &&
    event.finishReason === "stop"
  );
}

interface EffectLogEntry {
  callId: string;
  idempotencyKey?: string;
  input: unknown;
  recordedAtMs: number;
}

async function readEffectsLog(path: string): Promise<EffectLogEntry[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EffectLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("repl --serve-ws end-to-end", () => {
  let schemaName: string;
  let server: ServerHandle;

  beforeAll(async () => {
    schemaName = `tuvren_repl_ws_e2e_${crypto.randomUUID().replaceAll("-", "_")}`;
    server = await startServer(schemaName);
  }, 30_000);

  afterAll(async () => {
    await server?.kill().catch(() => undefined);
    await rm(server?.effectsLogPath ?? "", { force: true }).catch(
      () => undefined
    );

    // Disposable schema per the repo's persistent-smoke-target convention
    // (CLAUDE.md "Tests And PRs"): drop it unconditionally, even though the
    // subprocess is already dead, since PostgreSQL state outlives the process.
    const pg = requiredPostgresEnv();
    const sql = postgres({
      connect_timeout: 5,
      database: POSTGRES_DATABASE,
      host: pg.host,
      idle_timeout: 1,
      max: 1,
      onnotice: () => undefined,
      port: pg.port,
      prepare: false,
      username: pg.username,
    });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await sql.end({ timeout: 0 });
    }
  }, 30_000);

  test("variant A: dropping the client_result frame forces a reconnect whose completion REQUIRES server redelivery", async () => {
    const sessionId = `sess-a-${crypto.randomUUID()}`;
    const statuses: SessionClientStatus[] = [];
    const observedCursors: string[] = [];
    // Every client_invocation frame observed at the raw-socket/factory-wrapper
    // level, across BOTH connections (original + reattach), together with the
    // callId it named — the positive, direct proof that the server actually
    // redelivered the SAME call over the wire, independent of the client's
    // own in-flight dedup bookkeeping.
    const wireInvocationCallIds: string[] = [];
    let resultFrameDropped = false;
    let turnEnded = false;
    let invocationSeen = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const client = createSessionClient({
      capabilities: {
        [DEMO_CLIENT_CAPABILITY_ID]: async (input, ctx) => {
          invocationSeen += 1;
          await gate;
          await appendFile(
            server.effectsLogPath,
            `${JSON.stringify({
              callId: ctx.callId,
              idempotencyKey: ctx.idempotencyKey,
              input,
              recordedAtMs: Date.now(),
            })}\n`
          );
          return { acknowledged: true };
        },
      },
      onEvent(event, cursor) {
        if (cursor !== undefined) {
          observedCursors.push(cursor);
        }
        if (isFinalAssistantMessageDone(event)) {
          turnEnded = true;
        }
      },
      onStatusChange(status) {
        statuses.push(status);
      },
      sessionId,
      url: server.url,
      // This wrapper is the load-bearing part of the proof (M6 review
      // P1-1): it lets the peer's handler fully ANSWER the invocation, but
      // makes sure the server never receives that answer, and closes the
      // raw socket in the same tick — forcing session-client's ordinary
      // reconnect path rather than this test driving `session.close()` or
      // a process kill.
      webSocketFactory(url) {
        const real = new WebSocket(url);
        const wrapper: SessionClientSocket = {
          close(code, reason) {
            real.close(code, reason);
          },
          onclose: null,
          onerror: null,
          onmessage: null,
          onopen: null,
          send(data: string) {
            const outgoing = parseSessionFrameText(data);
            if (outgoing.kind === "client_result" && !resultFrameDropped) {
              resultFrameDropped = true;
              // Drop the bytes: `real.send` is never called for this
              // frame, so the server's RemoteClientSession never observes
              // a settling client_result and its pendingInvocations entry
              // for this callId survives. Closing the raw socket
              // synchronously (rather than merely delaying the send)
              // simulates the frame being lost in flight, not just slow.
              real.close(1001, "simulated client_result frame loss");
              return;
            }
            real.send(data);
          },
        };

        real.onopen = () => wrapper.onopen?.();
        real.onmessage = (event: MessageEvent) => {
          const incoming = parseSessionFrameText(
            typeof event.data === "string" ? event.data : ""
          );
          if (
            incoming.kind === "client_invocation" &&
            incoming.callId !== undefined
          ) {
            wireInvocationCallIds.push(incoming.callId);
          }
          wrapper.onmessage?.(event);
        };
        real.onclose = (event) => wrapper.onclose?.(event);
        real.onerror = (event) => wrapper.onerror?.(event);

        return wrapper;
      },
    });

    client.connect();

    await waitFor(() => statuses.some((status) => status.phase === "open"));
    await waitFor(() => invocationSeen >= 1);
    // The original client_invocation has been observed at the wire level.
    expect(wireInvocationCallIds.length).toBe(1);

    // Let the handler settle. `settle()` records the result (callState
    // becomes "answered") and sends the client_result frame — which the
    // wrapper above drops and, in dropping, closes the raw socket.
    releaseGate?.();

    await waitFor(() => resultFrameDropped);
    await waitFor(() =>
      statuses.some((status) => status.phase === "reconnecting")
    );
    await waitFor(
      () => statuses.filter((status) => status.phase === "open").length >= 2,
      20_000
    );

    // The redelivered client_invocation must not re-invoke the handler:
    // callState for this callId is "answered", so session-client re-sends
    // the recorded result instead of running the handler again.
    expect(invocationSeen).toBe(1);

    // Tight deadline, deliberately much shorter than the registry's default
    // dispatchTimeoutMs (10s): this is what makes completion load-bearing on
    // redelivery rather than on the dispatch-timeout's own synthesized-error
    // fallback. The server's attach()-time redelivery and the client's
    // answered-resend both happen synchronously inside the reattach
    // handshake, so if the redelivery loop fires at all, the turn completes
    // within a couple of seconds of the second "open" status above — not
    // within the ~10s a timeout-driven fallback would take. If
    // RemoteClientSession's redelivery loop were deleted, the server's
    // pendingInvocations entry would never be redelivered, the client would
    // never re-send its recorded result, and this wait would time out.
    await waitFor(() => turnEnded, 4000);

    // Positive arrival proof: the SAME callId was delivered over the wire
    // twice — once on the original connection, once redelivered on
    // reattach — not merely "the handler ran once".
    expect(wireInvocationCallIds.length).toBe(2);
    expect(wireInvocationCallIds[1]).toBe(wireInvocationCallIds[0]);

    // The runtime mints its own callId for the dispatched invocation
    // (distinct from the scripted provider's own `providerCallId`), so
    // dedup is asserted by total effect count rather than by matching a
    // literal callId: this server (shared by both tests in this file) has
    // recorded exactly one capability side effect at this point.
    const effects = await readEffectsLog(server.effectsLogPath);
    expect(effects.length).toBe(1);
    expect(typeof effects[0]?.idempotencyKey).toBe("string");
    expect((effects[0]?.idempotencyKey ?? "").length).toBeGreaterThan(0);

    // No duplicate cursor was ever delivered across the reconnect: the
    // event stream resumed from where it left off rather than restarting.
    expect(new Set(observedCursors).size).toBe(observedCursors.length);

    client.close(1000, "test complete");
  }, 30_000);

  test("variant B: durable commit survives a real SIGKILL of the server process", async () => {
    const sessionId = `sess-b-${crypto.randomUUID()}`;
    let turnEnded = false;

    const client = createSessionClient({
      capabilities: {
        [DEMO_CLIENT_CAPABILITY_ID]: (_input, ctx) => {
          return { acknowledged: true, callId: ctx.callId };
        },
      },
      onEvent(event) {
        if (isFinalAssistantMessageDone(event)) {
          turnEnded = true;
        }
      },
      sessionId,
      url: server.url,
    });

    client.connect();
    await waitFor(() => turnEnded, 20_000);
    client.close(1000, "variant B turn complete");

    const created = server.sessionsCreated.find(
      (entry) => entry.sessionId === sessionId
    );
    expect(created).toBeDefined();

    // Real process kill: not a graceful shutdown, not a simulated drop.
    await server.kill();

    // A genuinely new process (this test process) reopens the SAME durable
    // PostgreSQL schema the killed server wrote to, and reads back the
    // committed thread via the ordinary runtime read path — no server
    // process is involved in this read at all.
    const pg = requiredPostgresEnv();
    const backend = createPostgresBackend({
      database: POSTGRES_DATABASE,
      host: pg.host,
      port: pg.port,
      schemaName,
      username: pg.username,
    });
    const kernel = createRuntimeKernel({ backend });
    const readRuntime = createTuvrenRuntimeCore({
      defaultRunnerId: REACT_RUNNER_ID,
      kernel,
      runnerRegistry: createRunnerRegistry([
        createReActRunner({ providerCallMode: "stream" }),
      ]),
    });

    const branchId = created?.branchId as string;
    const messages = await readRuntime.readBranchMessages({ branchId });

    const toolResultMessages = messages.messages.filter(
      (message) =>
        isRecord(message) &&
        (message as Record<string, unknown>).role === "tool"
    );
    expect(toolResultMessages.length).toBeGreaterThan(0);

    const hasDemoResult = toolResultMessages.some((message) => {
      if (!isRecord(message)) {
        return false;
      }
      const parts = (message as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) {
        return false;
      }
      return parts.some(
        (part) =>
          isRecord(part) &&
          (part as Record<string, unknown>).name === DEMO_CLIENT_CAPABILITY_ID
      );
    });
    expect(hasDemoResult).toBe(true);

    // Deliberately NOT asserted here: reconnecting `sessionId` to a freshly
    // spawned server and expecting "resumed" continuation. See the
    // module-level comment for why that stronger claim is not honestly
    // provable with this runtime's current recovery semantics.
  }, 30_000);
});
