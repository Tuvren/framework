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
import { JsonRpcAdapterClient } from "../adapter-client.ts";

const clients: JsonRpcAdapterClient[] = [];

afterEach(async () => {
  const openClients = clients.splice(0);

  for (const client of openClients) {
    await client.shutdown().catch(() => undefined);
  }
});

function createClient(script: string): JsonRpcAdapterClient {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  clients.push(client);
  return client;
}

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
