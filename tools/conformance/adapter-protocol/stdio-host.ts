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

import { createInterface } from "node:readline";

import type {
  AdapterCapabilities,
  AdapterControls,
  AdapterErrorEnvelope,
  OperationOutcome,
} from "./index.js";

export interface StdioConformanceAdapter {
  startOperation?: (
    operation: string,
    argumentsValue: unknown,
    instance: unknown
  ) => Promise<{ operationHandle: string }>;
  awaitOperation?: (operationHandle: string) => Promise<OperationOutcome>;
  cancelOperation?: (operationHandle: string, reason: string) => Promise<void>;
  createInstance?: (input: unknown) => Promise<unknown>;
  destroyInstance?: (instance: unknown) => Promise<void>;
  dispatch: (
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown
  ) => OperationOutcome | Promise<OperationOutcome>;
  events?: (
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown
  ) => Promise<unknown[]> | AsyncIterable<unknown>;
  initialize: (
    packetId: string,
    planVersion: string
  ) => AdapterCapabilities | Promise<AdapterCapabilities>;
  inspectState?: (query: unknown, instance?: unknown) => Promise<unknown>;
  shutdown?: () => Promise<void>;
}

interface JsonRpcRequest {
  id: number | string;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAsyncIterableConsole = (
  value: Console
): value is Console & AsyncIterable<string> => Symbol.asyncIterator in value;

const readStdioLines = async function* readStdioLines(): AsyncIterable<string> {
  if (isAsyncIterableConsole(console)) {
    for await (const line of console) {
      yield line;
    }
    return;
  }

  const reader = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: process.stdin,
  });

  try {
    for await (const line of reader) {
      yield line;
    }
  } finally {
    reader.close();
  }
};

const collectEvents = async (
  events: AsyncIterable<unknown> | Iterable<unknown>
): Promise<unknown[]> => {
  const collected: unknown[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
};

const readControls = (value: unknown): AdapterControls => {
  if (!isRecord(value)) {
    return {};
  }

  const controls: {
    cancel?: {
      reason: string;
    };
    cancelAfterEvent?: string;
    deadlineMs?: number;
  } = {};

  if (isRecord(value.cancel) && typeof value.cancel.reason === "string") {
    controls.cancel = { reason: value.cancel.reason };
  }

  if (typeof value.cancelAfterEvent === "string") {
    controls.cancelAfterEvent = value.cancelAfterEvent;
  }

  if (typeof value.deadlineMs === "number") {
    controls.deadlineMs = value.deadlineMs;
  }

  return controls;
};

const errorResponse = (
  id: number | string | null,
  error: AdapterErrorEnvelope
) => ({
  error,
  id,
  jsonrpc: "2.0",
});

const createAdapterErrorEnvelope = (error: unknown): AdapterErrorEnvelope => {
  if (error instanceof Error) {
    return {
      code: "adapter_host_error",
      message: error.message,
    };
  }

  return {
    code: "adapter_host_error",
    message: String(error),
  };
};

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest =>
  isRecord(value) &&
  value.jsonrpc === "2.0" &&
  (typeof value.id === "number" || typeof value.id === "string") &&
  typeof value.method === "string";

const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
};

const dispatchMethod = async (
  adapter: StdioConformanceAdapter,
  method: string,
  params: unknown
): Promise<unknown> => {
  const paramObject = isRecord(params) ? params : {};

  switch (method) {
    case "initialize": {
      return await adapter.initialize(
        readString(paramObject.packetId, "packetId"),
        readString(paramObject.planVersion, "planVersion")
      );
    }
    case "createInstance": {
      return adapter.createInstance === undefined
        ? null
        : await adapter.createInstance(paramObject.input);
    }
    case "dispatch": {
      return await adapter.dispatch(
        readString(paramObject.operation, "operation"),
        paramObject.input,
        readControls(paramObject.controls),
        paramObject.instance
      );
    }
    case "startOperation": {
      if (adapter.startOperation === undefined) {
        throw new Error("adapter does not support startOperation");
      }
      return await adapter.startOperation(
        readString(paramObject.operation, "operation"),
        paramObject.arguments,
        paramObject.instance
      );
    }
    case "awaitOperation": {
      if (adapter.awaitOperation === undefined) {
        throw new Error("adapter does not support awaitOperation");
      }
      return await adapter.awaitOperation(
        readString(paramObject.operationHandle, "operationHandle")
      );
    }
    case "cancelOperation": {
      if (adapter.cancelOperation === undefined) {
        throw new Error("adapter does not support cancelOperation");
      }
      await adapter.cancelOperation(
        readString(paramObject.operationHandle, "operationHandle"),
        readString(paramObject.reason, "reason")
      );
      return null;
    }
    case "events": {
      return await collectEvents(
        adapter.events === undefined
          ? []
          : await adapter.events(
              readString(paramObject.operation, "operation"),
              paramObject.input,
              readControls(paramObject.controls),
              paramObject.instance
            )
      );
    }
    case "inspectState": {
      return adapter.inspectState === undefined
        ? null
        : await adapter.inspectState(paramObject.query, paramObject.instance);
    }
    case "destroyInstance": {
      if (adapter.destroyInstance !== undefined) {
        await adapter.destroyInstance(paramObject.instance);
      }
      return null;
    }
    case "shutdown": {
      if (adapter.shutdown !== undefined) {
        await adapter.shutdown();
      }
      return null;
    }
    default: {
      throw new Error(`unsupported adapter method ${method}`);
    }
  }
};

export const handleStdioAdapterLine = async (
  adapter: StdioConformanceAdapter,
  line: string
): Promise<unknown> => {
  let requestId: number | string | null = null;

  try {
    const request = JSON.parse(line) as unknown;

    if (!isJsonRpcRequest(request)) {
      return errorResponse(null, {
        code: "invalid_json_rpc_request",
        message: "request must be a JSON-RPC 2.0 object",
      });
    }

    // Once the frame is a valid JSON-RPC request, every host-side error must
    // echo the request id so the shared runner can correlate failures.
    requestId = request.id;
    const result = await dispatchMethod(
      adapter,
      request.method,
      request.params
    );
    return {
      id: request.id,
      jsonrpc: "2.0",
      result,
    };
  } catch (error: unknown) {
    return errorResponse(requestId, createAdapterErrorEnvelope(error));
  }
};

export const serveStdioAdapter = async (
  adapter: StdioConformanceAdapter
): Promise<void> => {
  const inFlight = new Map<symbol, Promise<void>>();
  let writeFailure: Error | undefined;
  let blockingDispatch = Promise.resolve();
  const respond = async (line: string): Promise<void> => {
    const response = await handleStdioAdapterLine(adapter, line);
    let serialized: string;
    try {
      serialized = JSON.stringify(response, (_key, value: unknown) => {
        if (
          typeof value === "bigint" ||
          typeof value === "function" ||
          typeof value === "symbol" ||
          (typeof value === "number" &&
            (!Number.isFinite(value) || Object.is(value, -0)))
        ) {
          throw new TypeError("response contains a non-JSON value");
        }
        return value;
      });
    } catch (error: unknown) {
      process.stderr.write(
        `adapter response serialization failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      serialized = JSON.stringify(
        errorResponse(
          isRecord(response) &&
            (typeof response.id === "number" || typeof response.id === "string")
            ? response.id
            : null,
          {
            code: "adapter_response_serialization_failed",
            message: "adapter response is not JSON-encodable",
          }
        )
      );
    }
    const written = Promise.withResolvers<undefined>();
    process.stdout.write(`${serialized}\n`, (error) => {
      if (error === undefined || error === null) {
        written.resolve();
      } else {
        written.reject(error);
      }
    });
    await written.promise;
  };
  const launchResponse = (line: string): void => {
    let predecessor = Promise.resolve();
    const completed = Promise.withResolvers<undefined>();
    try {
      const request: unknown = JSON.parse(line);
      if (isRecord(request) && request.method === "dispatch") {
        predecessor = blockingDispatch;
        blockingDispatch = completed.promise;
      }
    } catch {
      // Invalid frames are answered by handleStdioAdapterLine.
    }
    const taskId = Symbol("adapter response");
    const task = (async () => {
      try {
        await predecessor;
        await respond(line);
      } catch (error: unknown) {
        writeFailure =
          error instanceof Error ? error : new Error(String(error));
      } finally {
        completed.resolve();
        inFlight.delete(taskId);
      }
    })();
    inFlight.set(taskId, task);
  };
  for await (const line of readStdioLines()) {
    // Bun's console iterator can surface a final empty line for piped EOF; it is
    // transport noise, not a JSON-RPC frame, so adapters must stay silent.
    if (line.trim().length === 0) {
      continue;
    }

    launchResponse(line);
  }
  await Promise.all(inFlight.values());
  if (writeFailure !== undefined) {
    throw writeFailure;
  }
};
