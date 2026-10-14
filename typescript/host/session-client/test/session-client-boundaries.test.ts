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
import { setTimeout as delay } from "node:timers/promises";

import {
  ack,
  flush,
  makeClient,
  requiredRecord,
} from "./session-client-fixtures.js";
import type { FakeSocket } from "./session-client-fixtures.js";

const invocation = {
  callId: "guarded-call",
  capabilityId: "tool",
  idempotencyKey: "",
  input: [],
  leaseToken: "lease",
};
const rejection = {
  code: "session_frame_invalid",
  correlationId: "corr",
  message: "rejected",
};

const receiveInvocation = (socket: FakeSocket, value: unknown): void => {
  socket.receive({
    frame: { invocation: value, kind: "client_invocation" },
    kind: "frame",
  });
};

describe("session-client boundary guards and callback ordering", () => {
  test("invalid optional invocation fields leave the call available for valid dispatch", async () => {
    const calls: unknown[] = [];
    const { client, sockets } = makeClient({
      capabilities: {
        tool: (input, context) => {
          calls.push({ context, input });
          return "ok";
        },
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);
    for (const value of [null, 3, [], {}]) {
      receiveInvocation(socket, { ...invocation, idempotencyKey: value });
    }
    receiveInvocation(socket, []);
    expect(calls).toEqual([]);
    expect(socket.sent).toHaveLength(1);
    receiveInvocation(socket, invocation);
    receiveInvocation(socket, invocation);
    expect(calls).toEqual([]);
    await flush();
    expect(calls).toEqual([
      {
        context: {
          callId: "guarded-call",
          capabilityId: "tool",
          idempotencyKey: "",
        },
        input: [],
      },
    ]);
    expect(socket.sent).toHaveLength(2);
    expect(socket.lastFrame().result).toEqual({
      callId: "guarded-call",
      content: "ok",
      leaseToken: "lease",
    });
    client.close();
  });

  test("invalid optional rejection details are ignored and subsequent valid metadata is delivered", () => {
    const { client, rejections, sockets } = makeClient();
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);
    for (const details of [null, [], 2, "wrong", true]) {
      socket.receive({
        frame: {
          kind: "session_rejection",
          rejection: { ...rejection, details },
        },
        kind: "frame",
      });
    }
    expect(rejections).toEqual([]);
    for (const details of [
      undefined,
      {},
      { nested: [], runtimeErrorCode: "code" },
    ]) {
      socket.receive({
        frame: {
          kind: "session_rejection",
          rejection: { ...rejection, details },
        },
        kind: "frame",
      });
    }
    expect(rejections).toEqual([
      rejection,
      { ...rejection, details: {} },
      { ...rejection, details: { nested: [], runtimeErrorCode: "code" } },
    ]);
    client.close();
  });

  test("event and rejection callbacks run before deferred capability execution and duplicate dispatch stays suppressed", async () => {
    const trace: string[] = [];
    const { client, sockets } = makeClient({
      capabilities: {
        tool: () => {
          trace.push("handler");
          return "ok";
        },
      },
      onEvent: () => {
        trace.push("event");
      },
      onRejection: () => {
        trace.push("rejection");
      },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);
    receiveInvocation(socket, invocation);
    receiveInvocation(socket, invocation);
    trace.push("receive returned");
    socket.receive({
      cursor: "event-cursor",
      frame: { event: {}, kind: "event" },
      kind: "frame",
    });
    socket.receive({
      frame: { kind: "session_rejection", rejection },
      kind: "frame",
    });
    expect(trace).toEqual(["receive returned", "event", "rejection"]);
    await flush();
    expect(trace).toEqual([
      "receive returned",
      "event",
      "rejection",
      "handler",
    ]);
    expect(requiredRecord(socket.lastFrame().result).content).toBe("ok");
    receiveInvocation(socket, invocation);
    expect(trace).toHaveLength(4);
    expect(socket.sent).toHaveLength(3);
    client.close();
  });

  test("a default reconnect timer is cancelled by close before a replacement socket opens", async () => {
    const { client, sockets } = makeClient({
      clock: undefined,
      reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    client.connect();
    const [socket] = sockets;
    socket.open();
    ack(socket);
    socket.serverClose(4004);
    client.close();
    await delay(25);
    expect(sockets).toHaveLength(1);
  });
});
