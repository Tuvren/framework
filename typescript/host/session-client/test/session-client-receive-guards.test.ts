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
import { runInNewContext } from "node:vm";

import type { SessionClientInputSignal } from "../src/index.js";
import { ack, flush, makeClient } from "./session-client-fixtures.js";

const isUint8Array = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) &&
  Object.prototype.toString.call(value) === "[object Uint8Array]";

describe("session client receive guards", () => {
  test("only validated event envelopes advance replay cursor", async () => {
    const calls: string[] = [];
    const { client, clock, events, rejections, sockets } = makeClient({
      capabilities: {
        tool: () => {
          calls.push("handled");
          return "ok";
        },
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);

    socket.receive({
      cursor: "last-valid",
      frame: { event: { marker: "first" }, kind: "event" },
      kind: "frame",
    });
    socket.receive({
      cursor: "poisoned-missing-event",
      frame: { kind: "event" },
      kind: "frame",
    });
    socket.receive({
      cursor: "poisoned-unknown-kind",
      frame: { kind: "future-kind" },
      kind: "frame",
    });
    socket.receive({
      cursor: "",
      frame: { event: { marker: "invalid-cursor" }, kind: "event" },
      kind: "frame",
    });
    socket.receive({
      cursor: "poisoned-invocation",
      frame: {
        invocation: { callId: "missing-fields" },
        kind: "client_invocation",
      },
      kind: "frame",
    });
    socket.receive({
      cursor: "ignored-non-event",
      frame: {
        kind: "session_rejection",
        rejection: {
          code: "session_frame_invalid",
          correlationId: "c1",
          message: "bad",
        },
      },
      kind: "frame",
    });
    socket.receive({
      cursor: "ignored-rejection-cursor",
      frame: {
        kind: "session_rejection",
        rejection: {
          code: "session_frame_invalid",
          correlationId: "cursor-rejection",
          message: "must not be delivered",
        },
      },
      kind: "frame",
    });
    socket.receive({
      frame: {
        kind: "session_rejection",
        rejection: {
          code: "session_frame_invalid",
          correlationId: "cursorless-rejection",
          message: "delivered",
        },
      },
      kind: "frame",
    });
    socket.receive({
      cursor: "ignored-invocation-cursor",
      frame: {
        invocation: {
          callId: "cursor-invocation",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
      },
      kind: "frame",
    });
    socket.receive({
      frame: {
        invocation: {
          callId: "cursorless-invocation",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
      },
      kind: "frame",
    });
    socket.receive({
      frame: { event: { marker: "cursorless" }, kind: "event" },
      kind: "frame",
    });
    await flush();

    expect(events).toEqual([
      { cursor: "last-valid", event: { marker: "first" } },
      { cursor: "last-valid", event: { marker: "cursorless" } },
    ]);
    expect(rejections).toEqual([
      {
        code: "session_frame_invalid",
        correlationId: "cursorless-rejection",
        message: "delivered",
      },
    ]);
    expect(calls).toEqual(["handled"]);
    expect(socket.lastFrame()).toMatchObject({
      kind: "client_result",
      result: { callId: "cursorless-invocation", content: "ok" },
    });

    socket.serverClose(1006);
    clock.advance(250);
    const [reconnected] = sockets.slice(1);
    reconnected?.open();
    expect(reconnected?.lastSent()).toMatchObject({
      cursor: "last-valid",
      kind: "handshake",
    });
    client.close();
  });

  test("session frames stay blocked until a valid handshake ack", async () => {
    let resolveHandler: ((value: string) => void) | undefined;
    let handlerCalls = 0;
    const { client, clock, sockets } = makeClient({
      capabilities: {
        tool: async () => {
          handlerCalls += 1;
          const deferred = Promise.withResolvers<string>();
          resolveHandler = deferred.resolve;
          return await deferred.promise;
        },
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    client.cancel();
    socket.receive({
      kind: "handshake_ack",
      protocolVersion: "2",
      resumeStatus: "none",
      sessionId: "test-session",
    });
    socket.receive({
      cursor: "premature-cursor",
      frame: {
        invocation: {
          callId: "before-ack",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
      },
      kind: "frame",
    });
    await flush();
    expect(handlerCalls).toBe(0);
    expect(socket.sent).toHaveLength(1);

    socket.serverClose(1006);
    clock.advance(250);
    const [reconnected] = sockets.slice(1);
    if (reconnected === undefined) {
      throw new Error("retryable close did not create a reconnecting socket");
    }
    reconnected.open();
    expect(reconnected.lastSent()).toMatchObject({ kind: "handshake" });
    expect("cursor" in reconnected.lastSent()).toBe(false);

    ack(reconnected);
    expect(reconnected.sent).toHaveLength(2);
    expect(reconnected.lastFrame().kind).toBe("cancel");
    reconnected.receive({
      frame: {
        invocation: {
          callId: "after-ack",
          capabilityId: "tool",
          input: null,
          leaseToken: "lease",
        },
        kind: "client_invocation",
      },
      kind: "frame",
    });
    await flush();
    expect(handlerCalls).toBe(1);
    resolveHandler?.("accepted");
    await flush();
    expect(reconnected.lastFrame()).toMatchObject({
      kind: "client_result",
      result: { callId: "after-ack", content: "accepted" },
    });
    expect(reconnected.sent).toHaveLength(3);
    client.close();
  });

  test("cross-realm file bytes project to JSON arrays without changing other values", () => {
    const crossRealmValue: unknown = runInNewContext(
      "new Uint8Array([7, 8, 255])"
    );
    if (!isUint8Array(crossRealmValue)) {
      throw new TypeError("node:vm did not produce a Uint8Array");
    }
    const crossRealmBytes = crossRealmValue;
    const originalBuffer = crossRealmBytes.buffer;
    const { client, sockets } = makeClient();
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);

    client.steer({
      parts: [
        {
          data: crossRealmBytes,
          filename: "x.bin",
          mediaType: "application/octet-stream",
          providerMetadata: { tag: "kept" },
          type: "file",
        },
        {
          data: "text remains text",
          filename: "x.txt",
          mediaType: "text/plain",
          type: "file",
        },
        { text: "extra remains", type: "text" },
      ],
    } satisfies SessionClientInputSignal);

    expect(socket.lastFrame().signal).toEqual({
      parts: [
        {
          data: [7, 8, 255],
          filename: "x.bin",
          mediaType: "application/octet-stream",
          providerMetadata: { tag: "kept" },
          type: "file",
        },
        {
          data: "text remains text",
          filename: "x.txt",
          mediaType: "text/plain",
          type: "file",
        },
        { text: "extra remains", type: "text" },
      ],
    });
    expect(crossRealmBytes.buffer).toBe(originalBuffer);
    expect([...crossRealmBytes]).toEqual([7, 8, 255]);
    client.close();
  });
});
