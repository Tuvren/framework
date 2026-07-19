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
import { parseWsMessage } from "../src/lib/ws-messages.js";

describe("parseWsMessage", () => {
  test("round-trips a handshake message", () => {
    const message = {
      authToken: "secret",
      cursor: "cursor-1",
      kind: "handshake" as const,
      protocolVersion: "1",
      sessionId: "session-1",
    };

    expect(parseWsMessage(JSON.stringify(message))).toEqual({
      kind: "handshake",
      message,
    });
  });

  test("round-trips a minimal handshake message with only protocolVersion", () => {
    expect(
      parseWsMessage(
        JSON.stringify({ kind: "handshake", protocolVersion: "1" })
      )
    ).toEqual({
      kind: "handshake",
      message: { kind: "handshake", protocolVersion: "1" },
    });
  });

  test("round-trips a handshake_ack message", () => {
    const message = {
      kind: "handshake_ack" as const,
      protocolVersion: "1",
      resumeStatus: "resumed" as const,
      sessionId: "session-1",
    };

    expect(parseWsMessage(JSON.stringify(message))).toEqual({
      kind: "handshake_ack",
      message,
    });
  });

  test("round-trips every WsResumeStatus value on handshake_ack", () => {
    for (const resumeStatus of [
      "resumed",
      "out-of-window",
      "unknown-turn",
      "none",
    ] as const) {
      const message = {
        kind: "handshake_ack" as const,
        protocolVersion: "1",
        resumeStatus,
        sessionId: "session-1",
      };

      expect(parseWsMessage(JSON.stringify(message))).toEqual({
        kind: "handshake_ack",
        message,
      });
    }
  });

  test("round-trips a frame envelope without validating the inner frame payload", () => {
    const innerFrame = { anything: "goes", kind: "not-a-real-frame-kind" };

    expect(
      parseWsMessage(JSON.stringify({ frame: innerFrame, kind: "frame" }))
    ).toEqual({ frame: innerFrame, kind: "frame" });
  });

  test("round-trips a frame envelope carrying a cursor alongside the frame (cursor is not part of the inbound envelope shape but is ignored, not rejected)", () => {
    const innerFrame = { kind: "client_result" };

    expect(
      parseWsMessage(
        JSON.stringify({ cursor: "c-1", frame: innerFrame, kind: "frame" })
      )
    ).toEqual({ frame: innerFrame, kind: "frame" });
  });

  test("round-trips a ping message", () => {
    expect(parseWsMessage(JSON.stringify({ kind: "ping" }))).toEqual({
      kind: "ping",
    });
  });

  test("round-trips a pong message", () => {
    expect(parseWsMessage(JSON.stringify({ kind: "pong" }))).toEqual({
      kind: "pong",
    });
  });

  test("decodes a Uint8Array payload as UTF-8 before parsing", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ kind: "ping" }));

    expect(parseWsMessage(bytes)).toEqual({ kind: "ping" });
  });

  test("malformed JSON resolves to unparseable carrying the raw text", () => {
    const raw = "{not json";

    expect(parseWsMessage(raw)).toEqual({ kind: "unparseable", raw });
  });

  test("binary input that decodes to malformed JSON resolves to unparseable", () => {
    const raw = "not json at all";
    const bytes = new TextEncoder().encode(raw);

    expect(parseWsMessage(bytes)).toEqual({ kind: "unparseable", raw });
  });

  test("a JSON array resolves to unparseable", () => {
    const parsed = [1, 2, 3];

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a JSON object with an unrecognized kind resolves to unparseable", () => {
    const parsed = { data: "hi", kind: "not-a-real-kind" };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a JSON object with no kind field resolves to unparseable", () => {
    const parsed = { data: "hi" };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a handshake missing protocolVersion resolves to unparseable", () => {
    const parsed = { kind: "handshake" };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a handshake with a non-string protocolVersion resolves to unparseable", () => {
    const parsed = { kind: "handshake", protocolVersion: 1 };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a handshake with a non-string sessionId resolves to unparseable", () => {
    const parsed = {
      kind: "handshake",
      protocolVersion: "1",
      sessionId: 123,
    };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a handshake_ack with an invalid resumeStatus resolves to unparseable", () => {
    const parsed = {
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "not-a-real-status",
      sessionId: "session-1",
    };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("a handshake_ack missing sessionId resolves to unparseable", () => {
    const parsed = {
      kind: "handshake_ack",
      protocolVersion: "1",
      resumeStatus: "none",
    };

    expect(parseWsMessage(JSON.stringify(parsed))).toEqual({
      kind: "unparseable",
      raw: parsed,
    });
  });

  test("never throws on malformed input", () => {
    expect(() => parseWsMessage("null")).not.toThrow();
    expect(() => parseWsMessage("42")).not.toThrow();
    expect(() => parseWsMessage('"just a string"')).not.toThrow();
    expect(() => parseWsMessage("")).not.toThrow();
  });
});
