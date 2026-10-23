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

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

const PROTOCOL_DIR = import.meta.dirname;
const REPO_ROOT = nodePath.resolve(PROTOCOL_DIR, "../../..");
const ADAPTER_MANIFEST_ROOTS = ["typescript", "rust", "go", "python", "dart"];

interface ProtocolValidators {
  definition: (name: string) => ValidateFunction;
  manifest: ValidateFunction;
}

let validators: ProtocolValidators | undefined;

const readSchema = (fileName: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(
    readFileSync(nodePath.resolve(PROTOCOL_DIR, fileName), "utf-8")
  );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fileName} must contain a JSON Schema object`);
  }

  return value as Record<string, unknown>;
};

const loadValidators = (): ProtocolValidators => {
  if (validators !== undefined) {
    return validators;
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const protocolSchema = readSchema("protocol.schema.json");
  const protocolId = protocolSchema.$id;

  if (typeof protocolId !== "string") {
    throw new TypeError("protocol.schema.json must declare an $id");
  }

  ajv.addSchema(protocolSchema);
  const manifest = ajv.compile(readSchema("adapter-manifest.schema.json"));
  validators = {
    definition: (name) => {
      const validate = ajv.getSchema(`${protocolId}#/$defs/${name}`);

      if (validate === undefined) {
        throw new Error(`adapter protocol schema has no definition ${name}`);
      }

      return validate;
    },
    manifest,
  };
  return validators;
};

const run = (validate: ValidateFunction, value: unknown): readonly string[] =>
  validate(value)
    ? []
    : (validate.errors ?? []).map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
      );

export const validateAdapterDefinition = (
  name: string,
  value: unknown
): readonly string[] => run(loadValidators().definition(name), value);

export type AdapterFrameKind = "notification" | "request" | "response";

const FRAME_DEFINITIONS: Readonly<Record<AdapterFrameKind, string>> = {
  notification: "JsonRpcNotification",
  request: "JsonRpcRequest",
  response: "JsonRpcResponse",
};

export const validateAdapterFrame = (
  kind: AdapterFrameKind,
  frame: unknown
): readonly string[] =>
  validateAdapterDefinition(FRAME_DEFINITIONS[kind], frame);

export const validateAdapterManifest = (value: unknown): readonly string[] =>
  run(loadValidators().manifest, value);

const findManifestsUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = nodePath.resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return await findManifestsUnder(entryPath);
      }

      return entry.isFile() &&
        entry.name.startsWith("adapter") &&
        entry.name.endsWith(".json")
        ? [entryPath]
        : [];
    })
  );

  return nested.flat();
};

export const findAdapterManifests = async (): Promise<string[]> => {
  const manifests = await Promise.all(
    ADAPTER_MANIFEST_ROOTS.map(
      async (root) =>
        await findManifestsUnder(nodePath.resolve(REPO_ROOT, root))
    )
  );

  return manifests.flat().toSorted();
};

interface Frame {
  id?: number | string;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

const request = (id: number, method: string, params: unknown): Frame => ({
  id,
  jsonrpc: "2.0",
  method,
  params,
});

const notification = (method: string, params: unknown): Frame => ({
  jsonrpc: "2.0",
  method,
  params,
});

// Shapes the 0.1.0 runner sends today (tools/conformance/harness/adapter-client.ts).
export const PINNED_0_1_0_REQUESTS: readonly Frame[] = [
  request(1, "initialize", {
    packetId: "tuvren.kernel.protocol",
    planVersion: "0.1.0",
  }),
  request(2, "createInstance", { input: { checkInput: {} } }),
  request(3, "dispatch", {
    controls: { deadlineMs: 1000 },
    input: { checkInput: {} },
    instance: { id: "instance-1" },
    operation: "kernel.store.put",
  }),
  request(4, "events", {
    controls: {},
    input: {},
    operation: "kernel.store.put",
  }),
  request(5, "inspectState", { instance: null, query: { kind: "head" } }),
  request(6, "destroyInstance", { instance: null }),
  request(7, "shutdown", {}),
];

export const PINNED_0_2_0_REQUESTS: readonly Frame[] = [
  request(10, "createInstance", {
    clock: { backend: 1000 },
    input: {},
    scope: "tenant-a",
    storageRef: "storage-1",
  }),
  request(11, "openInstance", { scope: "tenant-a", storageRef: "storage-1" }),
  request(12, "startOperation", {
    arguments: { branchId: "main" },
    instance: "instance-1",
    operation: "kernel.run.commit",
  }),
  request(13, "awaitOperation", { operationHandle: "op-1" }),
  request(14, "cancelOperation", {
    operationHandle: "op-1",
    reason: "deadline",
  }),
  request(15, "subscribe", {
    channel: "run",
    instance: "instance-1",
    operationHandle: "op-1",
  }),
  request(16, "pull", { credit: 4, subscription: "sub-1" }),
  request(17, "armFault", {
    instance: "instance-1",
    mode: "block",
    occurrence: 1,
    point: "after-head-before-staging",
    selector: { operation: "kernel.run.commit" },
  }),
  request(18, "setClock", {
    domain: "backend",
    instance: "instance-1",
    nowMs: 1_700_000_000_000,
  }),
];

export const PINNED_0_2_0_NOTIFICATIONS: readonly Frame[] = [
  notification("event", {
    event: { type: "turn.start" },
    sequence: 0,
    subscription: "sub-1",
  }),
  notification("eventsEnd", { subscription: "sub-1", terminal: true }),
  notification("faultReached", {
    phase: "after-head-before-staging",
    processEpoch: 2,
    token: "fault-1",
  }),
];

export const PINNED_0_2_0_RESULTS: readonly (readonly [string, unknown])[] = [
  [
    "AdapterCapabilities",
    {
      adapterId: "typescript-kernel",
      capabilities: ["kernel.store"],
      packetId: "tuvren.kernel.protocol",
      planVersion: "0.12.0",
      profiles: ["kernel.memory"],
      protocolVersion: "0.2.0",
      storageKinds: ["none", "sqlite-directory"],
    },
  ],
  ["StartOperationResult", { operationHandle: "op-1" }],
  ["SubscribeResult", { subscription: "sub-1" }],
  ["ArmFaultResult", { token: "fault-1" }],
  [
    "OperationOutcome",
    {
      error: {
        code: "kernel_fault_injected",
        details: { token: "fault-1" },
        message: "fault",
      },
      kind: "error",
    },
  ],
];

export const PINNED_0_2_0_MANIFEST = {
  adapterId: "typescript-kernel-memory",
  authorityPackets: ["spec/kernel/authority-packet.json"],
  boundary: "kernel",
  capabilities: ["kernel.store"],
  command: ["bun", "typescript/kernel/conformance-adapter/src/main.ts"],
  executable: "typescript/kernel/conformance-adapter/dist/adapter",
  implementationId: "typescript-kernel",
  language: "typescript",
  profiles: ["kernel.memory"],
  protocol: {
    name: "tuvren.conformance-adapter",
    transport: "json-rpc-2.0-stdio",
    version: "0.2.0",
  },
  storage: "none",
  suiteId: "tuvren.kernel.protocol",
  suiteVersion: "0.12.0",
} as const;

export const MISMATCHED_PARAMETER_FRAMES: readonly {
  frame: Frame;
  kind: AdapterFrameKind;
  label: string;
}[] = [
  {
    frame: request(20, "cancelOperation", { handle: "op-1", reason: "x" }),
    kind: "request",
    label: "cancelOperation with handle instead of operationHandle",
  },
  {
    frame: request(21, "cancelOperation", { operationHandle: "op-1" }),
    kind: "request",
    label: "cancelOperation without a reason",
  },
  {
    frame: request(22, "awaitOperation", { operation: "op-1" }),
    kind: "request",
    label: "awaitOperation with operation instead of operationHandle",
  },
  {
    frame: request(23, "startOperation", {
      input: {},
      instance: "instance-1",
      operation: "kernel.run.commit",
    }),
    kind: "request",
    label: "startOperation with input instead of arguments",
  },
  {
    frame: request(24, "subscribe", {
      channel: "run",
      instance: "instance-1",
      operation: "op-1",
    }),
    kind: "request",
    label: "subscribe with operation instead of operationHandle",
  },
  {
    frame: request(25, "pull", { count: 1, subscription: "sub-1" }),
    kind: "request",
    label: "pull with count instead of credit",
  },
  {
    frame: request(26, "pull", { credit: 1.5, subscription: "sub-1" }),
    kind: "request",
    label: "pull with a fractional credit",
  },
  {
    frame: request(27, "pull", { credit: 0, subscription: "sub-1" }),
    kind: "request",
    label: "pull with zero credit",
  },
  {
    frame: request(28, "armFault", {
      instance: "instance-1",
      mode: "exit",
      occurrence: 1,
      point: "before-checkpoint-write",
      selector: {},
    }),
    kind: "request",
    label: "armFault with an unknown mode",
  },
  {
    frame: request(29, "armFault", {
      instance: "instance-1",
      mode: "throw",
      point: "before-checkpoint-write",
      selector: {},
    }),
    kind: "request",
    label: "armFault without an occurrence",
  },
  {
    frame: request(30, "setClock", {
      domain: "wall",
      instance: "instance-1",
      nowMs: 1,
    }),
    kind: "request",
    label: "setClock with an unknown domain",
  },
  {
    frame: request(31, "setClock", {
      domain: "worker",
      instance: "instance-1",
      now: 1,
    }),
    kind: "request",
    label: "setClock with now instead of nowMs",
  },
  {
    frame: request(32, "openInstance", { storage: "storage-1" }),
    kind: "request",
    label: "openInstance with storage instead of storageRef",
  },
  {
    frame: request(33, "createInstance", { input: {}, storage: "storage-1" }),
    kind: "request",
    label: "createInstance with storage instead of storageRef",
  },
  {
    frame: request(34, "dispatch", {
      controls: {},
      input: {},
      operationId: "kernel.store.put",
    }),
    kind: "request",
    label: "dispatch with operationId instead of operation",
  },
  {
    frame: request(35, "inspectState", { instance: null, state: {} }),
    kind: "request",
    label: "inspectState with state instead of query",
  },
  {
    frame: request(36, "teleport", {}),
    kind: "request",
    label: "an unknown method",
  },
  {
    frame: notification("event", { event: {}, seq: 0, subscription: "sub-1" }),
    kind: "notification",
    label: "event notification with seq instead of sequence",
  },
  {
    frame: notification("eventsEnd", { subscription: "sub-1" }),
    kind: "notification",
    label: "eventsEnd without terminal",
  },
  {
    frame: notification("faultReached", { phase: "x", token: "fault-1" }),
    kind: "notification",
    label: "faultReached without processEpoch",
  },
  {
    frame: { ...notification("faultReached", {}), id: 1 },
    kind: "notification",
    label: "a notification carrying an id",
  },
];

/** Throws unless every pinned frame validates and every mismatch is rejected. */
export const assertAdapterProtocolContracts = (): void => {
  const failures: string[] = [];
  const expectValid = (label: string, violations: readonly string[]): void => {
    if (violations.length > 0) {
      failures.push(`${label}: ${violations.join("; ")}`);
    }
  };

  for (const frame of [...PINNED_0_1_0_REQUESTS, ...PINNED_0_2_0_REQUESTS]) {
    expectValid(
      `${frame.method} request`,
      validateAdapterFrame("request", frame)
    );
  }

  for (const frame of PINNED_0_2_0_NOTIFICATIONS) {
    expectValid(
      `${frame.method} notification`,
      validateAdapterFrame("notification", frame)
    );
  }

  for (const [definition, value] of PINNED_0_2_0_RESULTS) {
    expectValid(definition, validateAdapterDefinition(definition, value));
  }

  expectValid("0.2.0 manifest", validateAdapterManifest(PINNED_0_2_0_MANIFEST));

  for (const { frame, kind, label } of MISMATCHED_PARAMETER_FRAMES) {
    if (validateAdapterFrame(kind, frame).length === 0) {
      failures.push(`accepted ${label}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `adapter protocol contract failed:\n${failures.join("\n")}`
    );
  }
};
