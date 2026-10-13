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
import { rejects } from "node:assert/strict";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";

import { createGrpcRuntimeKernel } from "../src/lib/grpc-kernel-client.js";

describe("gRPC runtime kernel forwarding", () => {
  test("rejects an empty base URL before invoking interceptors", () => {
    const calls: string[] = [];
    const interceptor: Interceptor = (next) => async (request) => {
      calls.push(request.method.name);
      return await next(request);
    };

    expect(() =>
      createGrpcRuntimeKernel({ baseUrl: "  ", interceptors: [interceptor] })
    ).toThrow("gRPC runtime kernel requires a base URL");
    expect(calls).toEqual([]);
  });

  test("detached methods retain their service receiver and normalize the URL", async () => {
    const calls: { method: string; url: string }[] = [];
    const responseReady = Promise.withResolvers<null>();
    const interceptor: Interceptor = () => async (request) => {
      calls.push({ method: request.method.name, url: request.url });
      if (request.stream) {
        throw new Error("expected a unary store call");
      }
      await responseReady.promise;
      return {
        header: new Headers(),
        message: create(request.method.output, {
          blob: new Uint8Array([1, 2, 3]),
          found: true,
        }),
        method: request.method,
        service: request.service,
        stream: false,
        trailer: new Headers(),
      };
    };
    const kernel = createGrpcRuntimeKernel({
      baseUrl: " http://127.0.0.1:1 ",
      interceptors: [interceptor],
    });
    const { get } = kernel.store;
    const response = get("stored-hash");
    responseReady.resolve(null);

    expect(await response).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([
      {
        method: "StoreGet",
        url: "http://127.0.0.1:1/tuvren.kernel.interop.v1.KernelStoreService/StoreGet",
      },
    ]);
  });

  test("walkBack yields received nodes before normalizing an iteration error", async () => {
    const events: string[] = [];
    const failure = new ConnectError("stream interrupted", Code.Unavailable);
    const responseReady = Promise.withResolvers<null>();
    const failureReady = Promise.withResolvers<null>();
    const interceptor: Interceptor = () => async (request) => {
      events.push("request");
      if (!request.stream) {
        throw new Error("expected a streaming node call");
      }
      await responseReady.promise;
      return {
        header: new Headers(),
        message: (async function* responses() {
          events.push("yield");
          yield create(request.method.output, {
            node: {
              consumedStagedResults: [],
              hash: "1".repeat(64),
              schemaId: "schema_main",
              turnTreeHash: "2".repeat(64),
            },
          });
          await failureReady.promise;
          events.push("fail");
          throw failure;
        })(),
        method: request.method,
        service: request.service,
        stream: true,
        trailer: new Headers(),
      };
    };
    const kernel = createGrpcRuntimeKernel({
      baseUrl: "http://127.0.0.1:1",
      interceptors: [interceptor],
    });
    const { walkBack } = kernel.node;
    const iterator = walkBack("1".repeat(64))[Symbol.asyncIterator]();

    expect(events).toEqual([]);
    const firstResponse = iterator.next();
    responseReady.resolve(null);
    expect(await firstResponse).toMatchObject({
      done: false,
      value: { hash: "1".repeat(64), previousTurnNodeHash: null },
    });
    expect(events).toEqual(["request", "yield"]);
    const nextResponse = iterator.next();
    expect(events).toEqual(["request", "yield"]);
    failureReady.resolve(null);
    await rejects(nextResponse, {
      cause: failure,
      code: "kernel_transport_error",
      details: {
        connectCode: Code.Unavailable,
        decodedDetails: undefined,
        metadata: {},
        operation: "node.walkBack",
      },
      message: "stream interrupted",
    });
    expect(events).toEqual(["request", "yield", "fail"]);
  });

  test("walkBack normalizes a failure before the first stream response", async () => {
    const failure = new ConnectError("stream unavailable", Code.Unavailable);
    const connectionFailed = Promise.withResolvers<null>();
    const interceptor: Interceptor = () => async () => {
      await connectionFailed.promise;
      throw failure;
    };
    const kernel = createGrpcRuntimeKernel({
      baseUrl: "http://127.0.0.1:1",
      interceptors: [interceptor],
    });
    const stream = kernel.node.walkBack("1".repeat(64));
    const iterator = stream[Symbol.asyncIterator]();
    const response = iterator.next();
    connectionFailed.resolve(null);

    await rejects(response, {
      cause: failure,
      code: "kernel_transport_error",
      details: {
        connectCode: Code.Unavailable,
        decodedDetails: undefined,
        metadata: {},
        operation: "node.walkBack",
      },
      message: "stream unavailable",
    });
  });
});
