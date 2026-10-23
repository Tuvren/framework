import { randomUUID } from "node:crypto";

import type { KernelRecord } from "@tuvren/core";

import type {
  AdapterErrorEnvelope,
  OperationOutcome,
} from "../../../../tools/conformance/adapter-protocol/index.js";
import type { KernelAdapterConfig } from "./host-scenario-support.js";
import {
  createConfiguredBackend,
  createConformanceRuntimeKernel,
  readErrorCode,
  readRecord,
  readString,
} from "./host-support.js";
import {
  encodeObservationInteger,
  encodeObservationRecord,
} from "./observation-encoding.js";

const HEX_BYTES = /^(?:[0-9a-f]{2})*$/u;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

const parameters = {
  "kernel.branch.create": ["branchId", "threadId", "fromTurnNodeHash"],
  "kernel.branch.get": ["branchId"],
  "kernel.branch.list": ["threadId"],
  "kernel.branch.setHead": ["branchId", "turnNodeHash"],
  "kernel.maintenance.reclaim": ["options"],
  "kernel.node.get": ["hash"],
  "kernel.node.walkBack": ["fromHash"],
  "kernel.run.beginStep": ["runId", "stepId"],
  "kernel.run.complete": ["runId", "status", "eventHash"],
  "kernel.run.completeStep": [
    "runId",
    "stepId",
    "eventHash",
    "observeResults",
    "treeHash",
  ],
  "kernel.run.create": [
    "runId",
    "turnId",
    "branchId",
    "schemaId",
    "startTurnNodeHash",
    "steps",
  ],
  "kernel.run.recover": ["runId"],
  "kernel.runLiveness.createLeasedRun": ["input"],
  "kernel.runLiveness.listExpired": ["nowMs"],
  "kernel.runLiveness.preemptExpired": [
    "runId",
    "preemptingOwnerId",
    "nowMs",
    "reason",
  ],
  "kernel.runLiveness.renewLease": [
    "runId",
    "executionOwnerId",
    "fencingToken",
    "nextLeaseExpiresAtMs",
  ],
  "kernel.schema.get": ["schemaId"],
  "kernel.schema.register": ["schema"],
  "kernel.staging.current": ["runId"],
  "kernel.staging.stage": [
    "runId",
    "blob",
    "taskId",
    "objectType",
    "status",
    "interruptPayload",
  ],
  "kernel.store.get": ["hash"],
  "kernel.store.has": ["hash"],
  "kernel.store.put": ["blob", "mediaType"],
  "kernel.thread.create": ["threadId", "schemaId", "initialBranchId"],
  "kernel.thread.get": ["threadId"],
  "kernel.thread.list": ["options"],
  "kernel.tree.create": ["schemaId", "changes", "baseTurnTreeHash"],
  "kernel.tree.diff": ["treeHashA", "treeHashB"],
  "kernel.tree.incorporate": ["baseTurnTreeHash", "stagedResults"],
  "kernel.tree.manifest": ["treeHash"],
  "kernel.tree.resolve": ["treeHash", "path"],
  "kernel.turn.create": [
    "turnId",
    "threadId",
    "branchId",
    "parentTurnId",
    "startTurnNodeHash",
  ],
  "kernel.turn.get": ["turnId"],
  "kernel.turn.updateHead": ["turnId", "headTurnNodeHash"],
  "kernel.verdicts.compose": ["verdicts"],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireSingleTag = (value: Record<string, unknown>): void => {
  if (Object.keys(value).length !== 1) {
    throw new TypeError("syscall tags cannot contain extra fields");
  }
};

const decode = (value: unknown): KernelRecord => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decode);
  }
  if (!isRecord(value)) {
    throw new TypeError("syscall argument is not a lossless kernel value");
  }
  if (Object.hasOwn(value, "$bytes")) {
    requireSingleTag(value);
    if (typeof value.$bytes !== "string") {
      throw new TypeError("invalid syscall byte string tag");
    }
    if (!HEX_BYTES.test(value.$bytes)) {
      throw new TypeError("invalid syscall byte string");
    }
    return new Uint8Array(Buffer.from(value.$bytes, "hex"));
  }
  if (Object.hasOwn(value, "$map")) {
    requireSingleTag(value);
    if (!Array.isArray(value.$map)) {
      throw new TypeError("invalid syscall map tag");
    }
    const keys = new Set<string>();
    const entries: [string, KernelRecord][] = [];
    for (const entry of value.$map) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string"
      ) {
        throw new TypeError("invalid syscall map entry");
      }
      if (keys.has(entry[0])) {
        throw new TypeError("duplicate syscall map key");
      }
      keys.add(entry[0]);
      entries.push([entry[0], decode(entry[1])]);
    }
    return Object.fromEntries(entries);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)])
  );
};

const recordFields = new Set([
  "metadata",
  "transform",
  "adjustment",
  "resumptionSchema",
  "interruptPayload",
]);

const decodeNativeRecord = (value: unknown): KernelRecord => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeNativeRecord);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        decodeNativeRecord(entry),
      ])
    );
  }
  return decode(value);
};

const encode = (value: unknown, record = false): unknown => {
  if (typeof value === "bigint") {
    if (value < -MAX_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
      throw new TypeError(
        "native integer exceeds the observation safe-integer domain"
      );
    }
    return Number(value);
  }
  if (typeof value === "number") {
    return encodeObservationInteger(value);
  }
  if (record) {
    return encodeObservationRecord(decodeNativeRecord(value));
  }
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => encode(entry));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, encode(entry, recordFields.has(key))])
    );
  }
  return value;
};

const nativeErrorEnvelope = (
  error: unknown,
  ancestors = new Set<unknown>()
): AdapterErrorEnvelope => {
  if (ancestors.has(error)) {
    throw new TypeError("cyclic native error cause");
  }
  const chain = new Set([...ancestors, error]);
  const details: unknown =
    error instanceof Error || isRecord(error)
      ? Reflect.get(error, "details")
      : undefined;
  const cause: unknown =
    error instanceof Error || isRecord(error)
      ? Reflect.get(error, "cause")
      : undefined;
  return {
    ...(cause === undefined
      ? {}
      : { cause: nativeErrorEnvelope(cause, chain) }),
    code: readErrorCode(error),
    ...(details === undefined ? {} : { details: encode(details) }),
    message: error instanceof Error ? error.message : String(error),
  };
};

interface Instance {
  cleanup: () => Promise<void>;
  kernel: ReturnType<typeof createConformanceRuntimeKernel>;
}

export const createSyscallBindings = (config: KernelAdapterConfig) => {
  const instances = new Map<string, Promise<Instance> | undefined>();
  const createInstance = async (): Promise<string> => {
    const handle = randomUUID();
    instances.set(handle, undefined);
    return await Promise.resolve(handle);
  };
  const destroyInstance = async (handle: unknown): Promise<void> => {
    if (typeof handle !== "string") {
      return;
    }
    const instance = instances.get(handle);
    instances.delete(handle);
    if (instance !== undefined) {
      const opened = await instance;
      await opened.cleanup();
    }
  };
  const dispatch = async (
    operation: string,
    input: unknown,
    handle: unknown
  ): Promise<OperationOutcome> => {
    if (!(typeof handle === "string" && instances.has(handle))) {
      throw new Error("syscall requires a live adapter instance");
    }
    let pending = instances.get(handle);
    if (pending === undefined) {
      pending = (async () => {
        const backend = await createConfiguredBackend(config);
        return {
          cleanup: backend.cleanup,
          kernel: createConformanceRuntimeKernel(config, {
            backend: backend.backend,
          }),
        };
      })();
      instances.set(handle, pending);
    }
    const { kernel } = await pending;
    const names: unknown = Reflect.get(parameters, operation);
    if (!Array.isArray(names)) {
      throw new TypeError(`unsupported syscall ${operation}`);
    }
    const args = readRecord(decode(input), "syscall arguments");
    const [, group, method] = operation.split(".");
    if (group === undefined || method === undefined) {
      throw new Error("invalid syscall operation");
    }
    const target: unknown = Reflect.get(kernel, group);
    if (!isRecord(target)) {
      throw new TypeError(`missing native syscall group ${group}`);
    }
    const invoke: unknown = target[method];
    if (typeof invoke !== "function") {
      throw new TypeError(`missing native syscall ${operation}`);
    }
    const callArguments = names.map((name: string) => args[name]);
    const fromHash =
      operation === "kernel.node.walkBack"
        ? readString(args.fromHash, "fromHash")
        : undefined;
    let value: unknown;
    try {
      if (fromHash === undefined) {
        value = await Reflect.apply(invoke, target, callArguments);
      } else {
        const nodes = [];
        for await (const node of kernel.node.walkBack(fromHash)) {
          nodes.push(node);
        }
        value = nodes;
      }
    } catch (error: unknown) {
      return {
        error: nativeErrorEnvelope(error),
        kind: "error",
      };
    }
    return {
      kind: "result",
      value: {
        result: encode(
          value === undefined ? {} : value,
          operation === "kernel.tree.manifest"
        ),
      },
    };
  };
  return {
    createInstance,
    destroyInstance,
    dispatch,
    has: (operation: string): boolean => Object.hasOwn(parameters, operation),
  };
};
