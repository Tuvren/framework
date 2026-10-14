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

import { afterEach, describe, expect, test } from "bun:test";

import {
  JsonRpcAdapterClient,
  JsonRpcAdapterError,
} from "../adapter-client.ts";

const clients: JsonRpcAdapterClient[] = [];

afterEach(async () => {
  const openClients = clients.splice(0);

  for (const client of openClients) {
    await client.shutdown().catch(() => undefined);
  }
});

const createClient = (script: string): JsonRpcAdapterClient => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  clients.push(client);
  return client;
};

describe("JsonRpcAdapterClient response correlation", () => {
  test("ignores non-numeric success responses as uncorrelatable noise", async () => {
    const client = createClient(`
      for await (const line of console) {
        const request = JSON.parse(line);
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({
            id: "noise",
            jsonrpc: "2.0",
            result: { ignored: true }
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            id: request.id,
            jsonrpc: "2.0",
            result: {
              adapterId: "test-adapter",
              capabilities: [],
              packetId: request.params.packetId,
              planVersion: request.params.planVersion
            }
          }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({
            id: request.id,
            jsonrpc: "2.0",
            result: null
          }) + "\\n");
        }
      }
    `);

    await expect(client.initialize("packet", "0.1.0")).resolves.toMatchObject({
      adapterId: "test-adapter",
    });
  });

  test("rejects pending requests on null-id JSON-RPC errors", async () => {
    const client = createClient(`
      for await (const _line of console) {
        process.stdout.write(JSON.stringify({
          error: { code: "invalid_json_rpc_request", message: "bad frame" },
          id: null,
          jsonrpc: "2.0"
        }) + "\\n");
      }
    `);

    await expect(client.initialize("packet", "0.1.0")).rejects.toThrow(
      "invalid_json_rpc_request: bad frame"
    );
  });

  test("rejects pending requests on string-id JSON-RPC errors", async () => {
    const client = createClient(`
      for await (const _line of console) {
        process.stdout.write(JSON.stringify({
          error: { code: "adapter_protocol_error", message: "wrong id" },
          id: "wrong",
          jsonrpc: "2.0"
        }) + "\\n");
      }
    `);

    await expect(client.initialize("packet", "0.1.0")).rejects.toThrow(
      "adapter_protocol_error: wrong id"
    );
  });

  test("rejects malformed JSON-RPC ids instead of timing out", async () => {
    const client = createClient(`
      for await (const _line of console) {
        process.stdout.write(JSON.stringify({
          id: { nested: 1 },
          jsonrpc: "2.0",
          result: null
        }) + "\\n");
      }
    `);

    await expect(client.initialize("packet", "0.1.0")).rejects.toThrow(
      "adapter stdout contained malformed JSON-RPC"
    );
  });
});

describe("JsonRpcAdapterClient request lifecycle", () => {
  test("correlates reversed responses and ignores unsolicited numeric IDs", async () => {
    const client = createClient(`
      let first;
      for await (const line of console) {
        const request = JSON.parse(line);
        if (request.method === "inspectState") {
          if (!first) { first = request; continue; }
          for (const entry of [{ id: 99999, params: { query: "noise" } }, request, first]) {
            process.stdout.write(JSON.stringify({ id: entry.id, jsonrpc: "2.0", result: entry.params.query }) + "\\n");
          }
        } else {
          process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", result: null }) + "\\n");
        }
      }
    `);

    expect(
      await Promise.all([
        client.inspectState("first"),
        client.inspectState("second"),
      ])
    ).toEqual(["first", "second"]);
  });

  test("retains nested adapter errors and handles later requests", async () => {
    const client = createClient(`
      for await (const line of console) {
        const request = JSON.parse(line);
        const response = request.params.query === "error"
          ? { error: { code: "outer", message: "first", cause: { code: "inner", message: "second" } } }
          : { result: request.params.query ?? null };
        process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", ...response }) + "\\n");
      }
    `);

    const [outcome] = await Promise.allSettled([client.inspectState("error")]);
    if (outcome?.status !== "rejected") {
      throw new Error("expected the request to reject");
    }
    const error: unknown = outcome.reason;
    expect(error).toBeInstanceOf(JsonRpcAdapterError);
    if (!(error instanceof JsonRpcAdapterError)) {
      throw new Error("expected an adapter error");
    }
    expect(error.message).toBe("outer: first");
    expect(error.envelope.cause).toEqual({ code: "inner", message: "second" });
    expect(await client.inspectState("next")).toBe("next");
  });

  test("removes timed-out requests and permits later requests and shutdown", async () => {
    const client = createClient(`
      for await (const line of console) {
        const request = JSON.parse(line);
        if (request.params.query === "timeout") { continue; }
        process.stdout.write(JSON.stringify({ id: request.id, jsonrpc: "2.0", result: request.params.query ?? null }) + "\\n");
      }
    `);

    const [outcome] = await Promise.allSettled([
      client.inspectState("timeout", undefined, 25),
    ]);
    if (outcome?.status !== "rejected") {
      throw new Error("expected the request to time out");
    }
    const error: unknown = outcome.reason;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected a timeout error");
    }
    expect(error.message).toBe("adapter request timed out: inspectState");
    expect(await client.inspectState("next")).toBe("next");
    await client.shutdown();
  });

  test("rejects all pending requests in insertion order when the process exits", async () => {
    const client = createClient(`
      let requests = 0;
      for await (const _line of console) {
        requests += 1;
        if (requests === 2) { process.exit(7); }
      }
    `);
    const order: string[] = [];
    const capture = async (label: string): Promise<unknown> => {
      try {
        return await client.inspectState(label);
      } catch (error: unknown) {
        order.push(label);
        return error;
      }
    };
    const errors = await Promise.all([capture("first"), capture("second")]);

    expect(order).toEqual(["first", "second"]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected a process exit error");
      }
      expect(error.message).toBe(
        "adapter process exited before completing all requests: code=7 signal=null"
      );
    }
    await client.shutdown();
  });
});
