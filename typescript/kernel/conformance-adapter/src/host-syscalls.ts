import { randomUUID } from "node:crypto";

import type { KernelRecord } from "@tuvren/core";
import {
  createKernelTestClock,
  createKernelFaultControl,
  createFaultInjectingBackend,
} from "@tuvren/kernel-testkit";

import type {
  AdapterErrorEnvelope,
  OperationOutcome,
} from "../../../../tools/conformance/adapter-protocol/index.js";
import { createOperationHandles } from "./host-operation-handles.js";
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

interface SyscallBinding {
  arguments: readonly unknown[];
  method?: string;
  recordResult?: boolean;
  target?: string;
}

const parameters = {
  "kernel.branch.create": {
    arguments: ["branchId", "threadId", "fromTurnNodeHash"],
  },
  "kernel.branch.get": { arguments: ["branchId"] },
  "kernel.branch.list": { arguments: ["threadId"] },
  "kernel.branch.setHead": { arguments: ["branchId", "turnNodeHash"] },
  "kernel.clock.set": {
    arguments: ["domain", "nowMs"],
    method: "set",
    target: "clock",
  },
  "kernel.fault.arm": {
    arguments: ["point", "selector", "occurrence", "mode"],
    method: "arm",
    target: "fault",
  },
  "kernel.maintenance.reclaim": { arguments: ["options"] },
  "kernel.node.get": { arguments: ["hash"] },
  "kernel.node.walkBack": { arguments: [{ name: "fromHash", type: "string" }] },
  "kernel.run.beginStep": { arguments: ["runId", "stepId"] },
  "kernel.run.complete": { arguments: ["runId", "status", "eventHash"] },
  "kernel.run.completeStep": {
    arguments: ["runId", "stepId", "eventHash", "observeResults", "treeHash"],
  },
  "kernel.run.create": {
    arguments: [
      "runId",
      "turnId",
      "branchId",
      "schemaId",
      "startTurnNodeHash",
      "steps",
    ],
  },
  "kernel.run.recover": { arguments: ["runId"] },
  "kernel.runLiveness.createLeasedRun": { arguments: ["input"] },
  "kernel.runLiveness.listExpired": { arguments: ["nowMs"] },
  "kernel.runLiveness.preemptExpired": {
    arguments: ["runId", "preemptingOwnerId", "nowMs", "reason"],
  },
  "kernel.runLiveness.renewLease": {
    arguments: [
      "runId",
      "executionOwnerId",
      "fencingToken",
      "nextLeaseExpiresAtMs",
    ],
  },
  "kernel.schema.get": { arguments: ["schemaId"] },
  "kernel.schema.register": { arguments: ["schema"] },
  "kernel.staging.current": { arguments: ["runId"] },
  "kernel.staging.stage": {
    arguments: [
      "runId",
      "blob",
      "taskId",
      "objectType",
      "status",
      "interruptPayload",
    ],
  },
  "kernel.store.get": { arguments: ["hash"] },
  "kernel.store.has": { arguments: ["hash"] },
  "kernel.store.put": { arguments: ["blob", "mediaType"] },
  "kernel.thread.create": {
    arguments: ["threadId", "schemaId", "initialBranchId"],
  },
  "kernel.thread.get": { arguments: ["threadId"] },
  "kernel.thread.list": { arguments: ["options"] },
  "kernel.tree.create": {
    arguments: ["schemaId", "changes", "baseTurnTreeHash"],
  },
  "kernel.tree.diff": { arguments: ["treeHashA", "treeHashB"] },
  "kernel.tree.incorporate": {
    arguments: ["baseTurnTreeHash", "stagedResults"],
  },
  "kernel.tree.manifest": { arguments: ["treeHash"], recordResult: true },
  "kernel.tree.resolve": { arguments: ["treeHash", "path"] },
  "kernel.turn.create": {
    arguments: [
      "turnId",
      "threadId",
      "branchId",
      "parentTurnId",
      "startTurnNodeHash",
    ],
  },
  "kernel.turn.get": { arguments: ["turnId"] },
  "kernel.turn.updateHead": { arguments: ["turnId", "headTurnNodeHash"] },
  "kernel.verdicts.compose": { arguments: ["verdicts"] },
} as const satisfies Readonly<Record<string, SyscallBinding>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSyscallBinding = (value: unknown): value is SyscallBinding =>
  isRecord(value) &&
  Array.isArray(value.arguments) &&
  (value.method === undefined || typeof value.method === "string") &&
  (value.target === undefined || typeof value.target === "string") &&
  (value.recordResult === undefined || typeof value.recordResult === "boolean");

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  isRecord(value) &&
  typeof Reflect.get(value, Symbol.asyncIterator) === "function";

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

const invokeBinding = async (
  target: unknown,
  binding: SyscallBinding,
  input: unknown,
  method: string
): Promise<OperationOutcome> => {
  if (!isRecord(target)) {
    throw new TypeError("missing native syscall target");
  }
  const args = readRecord(decode(input), "syscall arguments");
  const invoke: unknown =
    target[typeof binding.method === "string" ? binding.method : method];
  if (typeof invoke !== "function") {
    throw new TypeError("missing native syscall method");
  }
  const callArguments = binding.arguments.map((parameter: unknown) => {
    if (typeof parameter === "string") {
      return args[parameter];
    }
    if (
      isRecord(parameter) &&
      parameter.type === "string" &&
      typeof parameter.name === "string"
    ) {
      return readString(args[parameter.name], parameter.name);
    }
    throw new TypeError("invalid syscall parameter binding");
  });
  let value: unknown;
  try {
    value = await Reflect.apply(invoke, target, callArguments);
    if (isAsyncIterable(value)) {
      const entries: unknown[] = [];
      for await (const entry of value) {
        entries.push(entry);
      }
      value = entries;
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
        binding.recordResult === true
      ),
    },
  };
};

interface Instance {
  cleanup: () => Promise<void>;
  kernel: ReturnType<typeof createConformanceRuntimeKernel>;
  clock: ReturnType<typeof createKernelTestClock>;
  fault: ReturnType<typeof createKernelFaultControl>;
}

interface InstanceState {
  clock: ReturnType<typeof createKernelTestClock>;
  opened?: Promise<Instance>;
  destroying?: Promise<void>;
}

export const createSyscallBindings = (config: KernelAdapterConfig) => {
  const instances = new Map<string, InstanceState>();
  const createInstance = async (): Promise<string> => {
    const handle = randomUUID();
    instances.set(handle, { clock: createKernelTestClock() });
    return await Promise.resolve(handle);
  };
  const destroyInstance = async (handle: unknown): Promise<void> => {
    if (typeof handle !== "string") {
      return;
    }
    const instance = instances.get(handle)?.opened;
    instances.delete(handle);
    if (instance !== undefined) {
      const [settled] = await Promise.allSettled([instance]);
      if (settled?.status === "fulfilled") {
        await settled.value.cleanup();
      }
    }
  };
  const dispatch = async (
    operation: string,
    input: unknown,
    handle: unknown,
    signal?: AbortSignal
  ): Promise<OperationOutcome> => {
    const state =
      typeof handle === "string" ? instances.get(handle) : undefined;
    if (state === undefined || state.destroying !== undefined) {
      throw new Error("syscall requires a live adapter instance");
    }
    const binding: unknown = Reflect.get(parameters, operation);
    if (!isSyscallBinding(binding)) {
      throw new TypeError(`unsupported syscall ${operation}`);
    }
    const [, group, method] = operation.split(".");
    if (group === undefined || method === undefined) {
      throw new Error("invalid syscall operation");
    }
    signal?.throwIfAborted();
    const eagerTarget: unknown =
      typeof binding.target === "string"
        ? Reflect.get(state, binding.target)
        : undefined;
    if (eagerTarget !== undefined) {
      return await invokeBinding(eagerTarget, binding, input, method);
    }
    let pending = state.opened;
    if (pending === undefined) {
      pending = (async () => {
        const { clock } = state;
        const backend = await createConfiguredBackend(config, {
          now: clock.backendNow,
        });
        const fault = createKernelFaultControl(
          backend.backend,
          config.mutant?.wrapFaultInjection(createFaultInjectingBackend)
        );
        try {
          return {
            cleanup: backend.cleanup,
            clock,
            fault,
            kernel: createConformanceRuntimeKernel(config, {
              backend: fault.backend,
              now: clock.workerNow,
            }),
          };
        } catch (error: unknown) {
          await backend.cleanup();
          throw error;
        }
      })();
      state.opened = pending;
    }
    let opened: Instance;
    try {
      opened = await pending;
    } catch (error: unknown) {
      if (state.opened === pending) {
        delete state.opened;
      }
      throw error;
    }
    signal?.throwIfAborted();
    const target: unknown =
      typeof binding.target === "string"
        ? Reflect.get(opened, binding.target)
        : Reflect.get(opened.kernel, group);
    return await invokeBinding(target, binding, input, method);
  };
  const handles = createOperationHandles(dispatch, destroyInstance);
  return {
    awaitOperation: handles.awaitOperation,
    cancelOperation: handles.cancelOperation,
    createInstance,
    destroyInstance: async (handle: unknown): Promise<void> => {
      const state =
        typeof handle === "string" ? instances.get(handle) : undefined;
      if (state === undefined) {
        return;
      }
      state.destroying ??= handles.destroyInstance(handle);
      await state.destroying;
    },
    dispatch,
    has: (operation: string): boolean => Object.hasOwn(parameters, operation),
    startOperation: async (
      operation: string,
      input: unknown,
      instance: unknown
    ) => {
      if (!Object.hasOwn(parameters, operation)) {
        throw new Error(`unsupported syscall ${operation}`);
      }
      const state =
        typeof instance === "string" ? instances.get(instance) : undefined;
      if (state === undefined || state.destroying !== undefined) {
        throw new Error("syscall requires a live adapter instance");
      }
      return await handles.startOperation(operation, input, instance);
    },
  };
};
