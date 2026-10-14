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
import { setImmediate } from "node:timers/promises";

import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../adapter-protocol/index.ts";
import { handleStdioAdapterLine } from "../../adapter-protocol/stdio-host.ts";
import type { StdioConformanceAdapter } from "../../adapter-protocol/stdio-host.ts";
import { JsonRpcAdapterClient } from "../adapter-client.ts";
import { JsonRpcAdapterError } from "../adapter-error.ts";

const clients: JsonRpcAdapterClient[] = [];

afterEach(async () => {
  const openClients = clients.splice(0);

  const close = async (index: number): Promise<void> => {
    const client = openClients[index];
    if (client === undefined) {
      return;
    }
    try {
      await client.shutdown();
    } catch {
      // Best-effort test cleanup.
    }
    await close(index + 1);
  };
  await close(0);
});

const frame = (method: string, params: unknown) =>
  JSON.stringify({ id: 7, jsonrpc: "2.0", method, params });

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

    expect(await client.initialize("packet", "0.1.0")).toMatchObject({
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

    const request = client.initialize("packet", "0.1.0");
    expect(request).rejects.toThrow("invalid_json_rpc_request: bad frame");
    await Promise.allSettled([request]);
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

    const request = client.initialize("packet", "0.1.0");
    expect(request).rejects.toThrow("adapter_protocol_error: wrong id");
    await Promise.allSettled([request]);
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

    const request = client.initialize("packet", "0.1.0");
    expect(request).rejects.toThrow(
      "adapter stdout contained malformed JSON-RPC"
    );
    await Promise.allSettled([request]);
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

describe("stdio host callback parity", () => {
  test.each([false, true])(
    "preserves responses and controls with async=%s",
    async (asynchronous) => {
      const controls = {
        cancel: { reason: "stop" },
        cancelAfterEvent: "turn.end",
        deadlineMs: 25,
      };
      const observed: unknown[] = [];
      const synchronousAdapter = {
        dispatch(
          operation: string,
          input: unknown,
          receivedControls: AdapterControls,
          instance?: unknown
        ): OperationOutcome {
          observed.push({ input, instance, operation, receivedControls });
          if (operation === "throw") {
            throw new Error("native failure");
          }
          return operation === "error"
            ? {
                error: {
                  cause: { code: "inner", message: "cause" },
                  code: "native",
                  message: "failure",
                },
                kind: "error" as const,
              }
            : {
                kind: "result" as const,
                value: { controls: receivedControls, input, instance },
              };
        },
        initialize(packetId: string, planVersion: string): AdapterCapabilities {
          return {
            adapterId: "parity",
            capabilities: ["parity"],
            packetId,
            planVersion,
          };
        },
      };
      const adapter: StdioConformanceAdapter = asynchronous
        ? {
            async dispatch(operation, input, receivedControls, instance) {
              await setImmediate();
              return synchronousAdapter.dispatch(
                operation,
                input,
                receivedControls,
                instance
              );
            },
            async initialize(packetId, planVersion) {
              await setImmediate();
              return synchronousAdapter.initialize(packetId, planVersion);
            },
          }
        : synchronousAdapter;
      expect(
        JSON.stringify(
          await handleStdioAdapterLine(
            adapter,
            frame("initialize", { packetId: "packet", planVersion: "0.1.0" })
          )
        )
      ).toBe(
        JSON.stringify({
          id: 7,
          jsonrpc: "2.0",
          result: {
            adapterId: "parity",
            capabilities: ["parity"],
            packetId: "packet",
            planVersion: "0.1.0",
          },
        })
      );
      const params = {
        controls,
        input: { text: "héllo" },
        instance: "instance",
        operation: "result",
      };
      expect(
        await handleStdioAdapterLine(adapter, frame("dispatch", params))
      ).toEqual({
        id: 7,
        jsonrpc: "2.0",
        result: {
          kind: "result",
          value: { controls, input: params.input, instance: "instance" },
        },
      });
      expect(observed).toEqual([
        {
          input: params.input,
          instance: "instance",
          operation: "result",
          receivedControls: controls,
        },
      ]);
      expect(
        await handleStdioAdapterLine(
          adapter,
          frame("dispatch", { ...params, operation: "error" })
        )
      ).toEqual({
        id: 7,
        jsonrpc: "2.0",
        result: {
          error: {
            cause: { code: "inner", message: "cause" },
            code: "native",
            message: "failure",
          },
          kind: "error",
        },
      });
      expect(
        JSON.stringify(
          await handleStdioAdapterLine(
            adapter,
            frame("dispatch", { ...params, operation: "throw" })
          )
        )
      ).toBe(
        JSON.stringify({
          error: { code: "adapter_host_error", message: "native failure" },
          id: 7,
          jsonrpc: "2.0",
        })
      );
      const initializeFailure: StdioConformanceAdapter = {
        ...adapter,
        initialize() {
          throw new Error("initialize failure");
        },
      };
      expect(
        await handleStdioAdapterLine(
          initializeFailure,
          frame("initialize", { packetId: "packet", planVersion: "0.1.0" })
        )
      ).toEqual({
        error: { code: "adapter_host_error", message: "initialize failure" },
        id: 7,
        jsonrpc: "2.0",
      });
      const rejectedAdapter: StdioConformanceAdapter = {
        ...adapter,
        async dispatch() {
          await setImmediate();
          throw new Error("native failure");
        },
        async initialize() {
          await setImmediate();
          throw new Error("initialize failure");
        },
      };
      expect(
        await handleStdioAdapterLine(rejectedAdapter, frame("dispatch", params))
      ).toEqual({
        error: { code: "adapter_host_error", message: "native failure" },
        id: 7,
        jsonrpc: "2.0",
      });
      expect(
        await handleStdioAdapterLine(
          rejectedAdapter,
          frame("initialize", { packetId: "packet", planVersion: "0.1.0" })
        )
      ).toEqual({
        error: { code: "adapter_host_error", message: "initialize failure" },
        id: 7,
        jsonrpc: "2.0",
      });
    }
  );

  test("serializes async host dispatches and preserves cancellation/deadline controls", async () => {
    const host = new URL(
      "../../adapter-protocol/stdio-host.ts",
      import.meta.url
    ).href;
    const client = createClient(`
      import { serveStdioAdapter } from ${JSON.stringify(host)};
      import { setImmediate } from "node:timers/promises";
      const order = [];
      await serveStdioAdapter({
        initialize: (packetId, planVersion) => ({ adapterId: "parity", capabilities: [], packetId, planVersion }),
        async dispatch(operation, input, controls) {
          order.push(operation + ".start");
          await setImmediate();
          order.push(operation + ".end");
          return { kind: "result", value: { controls, input, order: [...order] } };
        }
      });
    `);
    const controls = {
      cancel: { reason: "stop" },
      cancelAfterEvent: "turn.end",
      deadlineMs: 50,
    };
    const results = await Promise.all([
      client.dispatch("first", "héllo", controls),
      client.dispatch("second", "world", {}),
    ]);
    expect(results).toEqual([
      {
        kind: "result",
        value: {
          controls,
          input: "héllo",
          order: ["first.start", "first.end"],
        },
      },
      {
        kind: "result",
        value: {
          controls: {},
          input: "world",
          order: ["first.start", "first.end", "second.start", "second.end"],
        },
      },
    ]);
  });

  test("times out a large request to a non-reading adapter and shuts down", async () => {
    const client = createClient("setInterval(() => {}, 1000)");
    const [outcome] = await Promise.allSettled([
      client.inspectState("x".repeat(8 * 1024 * 1024), undefined, 25),
    ]);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status !== "rejected") {
      throw new Error("expected a timeout");
    }
    const error: unknown = outcome.reason;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected a timeout Error");
    }
    expect(error.message).toBe("adapter request timed out: inspectState");
    await client.shutdown();
  });
});
