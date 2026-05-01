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

import type {
  AdapterCapabilities,
  AdapterControls,
  AdapterErrorEnvelope,
  OperationOutcome,
} from "./index.js";

export interface StdioConformanceAdapter {
  createInstance?(input: unknown): Promise<unknown>;
  destroyInstance?(instance: unknown): Promise<void>;
  dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown
  ): Promise<OperationOutcome>;
  events?(
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown
  ): Promise<unknown[]> | AsyncIterable<unknown>;
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities>;
  inspectState?(query: unknown, instance?: unknown): Promise<unknown>;
  shutdown?(): Promise<void>;
}

interface JsonRpcRequest {
  id: number | string;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export async function serveStdioAdapter(
  adapter: StdioConformanceAdapter
): Promise<void> {
  for await (const line of console) {
    // Bun's console iterator can surface a final empty line for piped EOF; it is
    // transport noise, not a JSON-RPC frame, so adapters must stay silent.
    if (line.trim().length === 0) {
      continue;
    }

    const response = await handleStdioAdapterLine(adapter, line);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

export async function handleStdioAdapterLine(
  adapter: StdioConformanceAdapter,
  line: string
): Promise<unknown> {
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
}

async function dispatchMethod(
  adapter: StdioConformanceAdapter,
  method: string,
  params: unknown
): Promise<unknown> {
  const paramObject = isRecord(params) ? params : {};

  switch (method) {
    case "initialize":
      return await adapter.initialize(
        readString(paramObject.packetId, "packetId"),
        readString(paramObject.planVersion, "planVersion")
      );
    case "createInstance":
      return adapter.createInstance === undefined
        ? null
        : await adapter.createInstance(paramObject.input);
    case "dispatch":
      return await adapter.dispatch(
        readString(paramObject.operation, "operation"),
        paramObject.input,
        readControls(paramObject.controls),
        paramObject.instance
      );
    case "events":
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
    case "inspectState":
      return adapter.inspectState === undefined
        ? null
        : await adapter.inspectState(paramObject.query, paramObject.instance);
    case "destroyInstance":
      if (adapter.destroyInstance !== undefined) {
        await adapter.destroyInstance(paramObject.instance);
      }
      return null;
    case "shutdown":
      if (adapter.shutdown !== undefined) {
        await adapter.shutdown();
      }
      return null;
    default:
      throw new Error(`unsupported adapter method ${method}`);
  }
}

async function collectEvents(
  events: AsyncIterable<unknown> | Iterable<unknown>
): Promise<unknown[]> {
  const collected: unknown[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

function readControls(value: unknown): AdapterControls {
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
}

function errorResponse(
  id: number | string | null,
  error: AdapterErrorEnvelope
) {
  return {
    error,
    id,
    jsonrpc: "2.0",
  };
}

function createAdapterErrorEnvelope(error: unknown): AdapterErrorEnvelope {
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
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    typeof value.method === "string"
  );
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
