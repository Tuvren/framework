import { expect, test, spyOn } from "bun:test";

import { decodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import { createKernelTestClock } from "@tuvren/kernel-testkit";

import * as hostSupport from "../src/host-support.ts";
import { createSyscallBindings } from "../src/host-syscalls.ts";

const config = {
  adapterId: "clock-fault-contract",
  backend: "memory",
  capabilities: ["kernel.syscall"],
} as const;

test.each(["memory", "sqlite"] as const)(
  "%s rejects the backend server clock source",
  async (backend) => {
    const bridge = createSyscallBindings({ ...config, backend });
    const instance = await bridge.createInstance(
      undefined,
      backend === "sqlite" ? { storageRef: "unused" } : {}
    );
    try {
      expect(
        await bridge.dispatch(
          "kernel.clock.set",
          { domain: "backend", source: "server" },
          instance
        )
      ).toMatchObject({
        error: { code: "clock_source_unsupported" },
        kind: "error",
      });
    } finally {
      await bridge.destroyInstance(instance);
    }
  }
);

test.each(["adapter.json", "adapter-sqlite.json"])(
  "%s does not claim the server clock capability",
  async (file) => {
    const manifest: unknown = await Bun.file(
      new URL(`../${file}`, import.meta.url)
    ).json();
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("capabilities" in manifest) ||
      !Array.isArray(manifest.capabilities)
    ) {
      throw new Error("invalid adapter capabilities");
    }
    expect(manifest.capabilities).not.toContain("clock.backend-server");
  }
);

test("postgres server clock does not inject the adapter backend clock", async () => {
  const original = hostSupport.createConfiguredBackend;
  const factory = spyOn(
    hostSupport,
    "createConfiguredBackend"
  ).mockImplementation(async (adapterConfig, options) => {
    expect(options?.now).toBeUndefined();
    return await original({ ...adapterConfig, backend: "memory" }, options);
  });
  const bridge = createSyscallBindings({
    ...config,
    backend: "postgres",
    capabilities: ["kernel.syscall", "clock.backend-server"],
  });
  const instance = await bridge.createInstance(undefined, {
    storageRef: "unused",
  });
  try {
    expect(
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "backend", source: "server" },
        instance
      )
    ).toMatchObject({ kind: "result" });
    expect(
      await bridge.dispatch("kernel.backend.capabilities", {}, instance)
    ).toMatchObject({ kind: "result" });
    expect(factory).toHaveBeenCalledTimes(1);
  } finally {
    await bridge.destroyInstance(instance);
    factory.mockRestore();
  }
});

test("switching backend clock sources reopens the backend with the selected source", async () => {
  const original = hostSupport.createConfiguredBackend;
  const sources: boolean[] = [];
  const factory = spyOn(
    hostSupport,
    "createConfiguredBackend"
  ).mockImplementation(async (adapterConfig, options) => {
    sources.push(options?.now !== undefined);
    return await original({ ...adapterConfig, backend: "memory" }, options);
  });
  const bridge = createSyscallBindings({
    ...config,
    backend: "postgres",
    capabilities: ["kernel.syscall", "clock.backend-server"],
  });
  const instance = await bridge.createInstance(undefined, {
    storageRef: "unused",
  });
  try {
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "backend", nowMs: 1 },
      instance
    );
    await bridge.dispatch("kernel.backend.capabilities", {}, instance);
    expect(
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "backend", source: "server" },
        instance
      )
    ).toMatchObject({ kind: "result" });
    await bridge.dispatch("kernel.backend.capabilities", {}, instance);
    expect(
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: 2, source: "injected" },
        instance
      )
    ).toMatchObject({ kind: "result" });
    await bridge.dispatch("kernel.backend.capabilities", {}, instance);
    expect(sources).toEqual([true, false, true]);
  } finally {
    await bridge.destroyInstance(instance);
    factory.mockRestore();
  }
});

test("backend capability observations come from the instance's backend", async () => {
  const original = hostSupport.createConfiguredBackend;
  let sharedLeaseClock = false;
  const factory = spyOn(
    hostSupport,
    "createConfiguredBackend"
  ).mockImplementation(async (adapterConfig, options) => {
    const configured = await original(adapterConfig, options);
    return {
      ...configured,
      backend: {
        ...configured.backend,
        capabilities: () => ({
          ...configured.backend.capabilities(),
          "shared-lease-clock": sharedLeaseClock,
        }),
      },
    };
  });
  const bridge = createSyscallBindings(config);
  const handle = await bridge.createInstance();
  try {
    const observe = async () =>
      await bridge.dispatch("kernel.backend.capabilities", {}, handle);
    expect(await observe()).toMatchObject({
      kind: "result",
      value: { result: { "shared-lease-clock": false } },
    });
    sharedLeaseClock = true;
    expect(await observe()).toMatchObject({
      kind: "result",
      value: { result: { "shared-lease-clock": true } },
    });
  } finally {
    await bridge.destroyInstance(handle);
    factory.mockRestore();
  }
});

for (const point of ["before-commit", "after-commit-before-ack"]) {
  test(`armed ${point} returns a token carried by the typed native fault`, async () => {
    const bridge = createSyscallBindings(config);
    const handle = await bridge.createInstance();
    try {
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: 123 },
        handle
      );
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "worker", nowMs: 456 },
        handle
      );
      const armed = await bridge.dispatch(
        "kernel.fault.arm",
        { mode: "throw", occurrence: 2, point, selector: {} },
        handle
      );
      if (
        armed.kind !== "result" ||
        typeof armed.value !== "object" ||
        armed.value === null ||
        !("result" in armed.value) ||
        typeof armed.value.result !== "object" ||
        armed.value.result === null ||
        !("token" in armed.value.result) ||
        typeof armed.value.result.token !== "string"
      ) {
        throw new Error("armFault must return an activation token");
      }
      const { token } = armed.value.result;
      expect(token.length).toBeGreaterThan(0);
      const schema = { incorporationRules: [], paths: [], schemaId: "first" };
      const first = await bridge.dispatch(
        "kernel.schema.register",
        { schema },
        handle
      );
      expect(first.kind).toBe("result");
      const fault = await bridge.dispatch(
        "kernel.schema.register",
        { schema: { ...schema, schemaId: "second" } },
        handle
      );
      expect(fault).toMatchObject({
        error: {
          code: "kernel_persistence_fault_injected",
          details: { point },
        },
        kind: "error",
      });
      if (fault.kind !== "error") {
        throw new Error("missing fault contract outcomes");
      }
      expect(fault.error.details).toEqual({ point, token });
      const third = await bridge.dispatch(
        "kernel.schema.register",
        { schema: { ...schema, schemaId: "third" } },
        handle
      );
      expect(third.kind).toBe("result");
    } finally {
      await bridge.destroyInstance(handle);
    }
  });
}

test.each([
  "after-turn-node-write-before-head",
  "after-head-move-before-staging-clear",
  "commit-outcome-unknown",
])("memory rejects unreachable storage point %s", async (point) => {
  const bridge = createSyscallBindings(config);
  const handle = await bridge.createInstance();
  try {
    expect(
      await bridge.dispatch(
        "kernel.fault.arm",
        { mode: "throw", occurrence: 1, point, selector: {} },
        handle
      )
    ).toMatchObject({
      error: { code: "kernel_fault_point_unsupported" },
      kind: "error",
    });
  } finally {
    await bridge.destroyInstance(handle);
  }
});

test("backend and worker timestamps follow only their setClock domain", async () => {
  const bridge = createSyscallBindings(config);
  const handle = await bridge.createInstance();
  const wallClock = spyOn(Date, "now").mockImplementation(() => {
    throw new Error("wall clock observed after setClock");
  });
  try {
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "backend", nowMs: 100 },
      handle
    );
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "worker", nowMs: 200 },
      handle
    );
    await bridge.dispatch(
      "kernel.schema.register",
      {
        schema: {
          incorporationRules: [
            { objectType: "message", targetPath: "messages" },
          ],
          paths: [{ collection: "ordered", path: "messages" }],
          schemaId: "schema",
        },
      },
      handle
    );
    const thread = await bridge.dispatch(
      "kernel.thread.create",
      { initialBranchId: "branch", schemaId: "schema", threadId: "thread" },
      handle
    );
    expect(thread.kind).toBe("result");
    expect(
      await bridge.dispatch("kernel.thread.list", {}, handle)
    ).toMatchObject({
      kind: "result",
      value: { result: { threads: [{ createdAtMs: 200 }] } },
    });
  } finally {
    wallClock.mockRestore();
    await bridge.destroyInstance(handle);
  }
});

test("runner clocks require explicit initialization of both domains", () => {
  const clock = createKernelTestClock();
  expect(() => clock.backendNow()).toThrow("setClock required for backend");
  expect(() => clock.workerNow()).toThrow("setClock required for worker");
  clock.set("backend", 123);
  expect(clock.backendNow()).toBe(123);
  expect(() => clock.workerNow()).toThrow("setClock required for worker");
});

test("arming tokens are deterministic and unique within an instance", async () => {
  const bridge = createSyscallBindings(config);
  const first = await bridge.createInstance();
  const second = await bridge.createInstance();
  const input = {
    mode: "throw",
    occurrence: 1,
    point: "before-commit",
    selector: {},
  };
  try {
    const one = await bridge.dispatch("kernel.fault.arm", input, first);
    const two = await bridge.dispatch("kernel.fault.arm", input, first);
    const fresh = await bridge.dispatch("kernel.fault.arm", input, second);
    expect(one).toEqual(fresh);
    expect(one).not.toEqual(two);
  } finally {
    await bridge.destroyInstance(first);
    await bridge.destroyInstance(second);
  }
});

for (const [backendMs, workerMs] of [
  [100, 200],
  [200, 100],
]) {
  test(`backend stamps ordered chunks at ${backendMs} while worker uses ${workerMs}`, async () => {
    let backend: RuntimeBackend | undefined;
    const original = hostSupport.createConfiguredBackend;
    const factory = spyOn(
      hostSupport,
      "createConfiguredBackend"
    ).mockImplementation(async (adapterConfig, options) => {
      const opened = await original(adapterConfig, options);
      ({ backend } = opened);
      return opened;
    });
    const bridge = createSyscallBindings(config);
    const instance = await bridge.createInstance();
    const wallClock = spyOn(Date, "now").mockImplementation(() => {
      throw new Error("unexpected wall clock");
    });
    try {
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: backendMs },
        instance
      );
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "worker", nowMs: workerMs },
        instance
      );
      await bridge.dispatch(
        "kernel.schema.register",
        {
          schema: {
            incorporationRules: [],
            paths: [{ collection: "ordered", path: "messages" }],
            schemaId: "chunks",
          },
        },
        instance
      );
      const object = await bridge.dispatch(
        "kernel.store.put",
        { blob: { $bytes: "01" } },
        instance
      );
      if (
        object.kind !== "result" ||
        typeof object.value !== "object" ||
        object.value === null ||
        !("result" in object.value) ||
        typeof object.value.result !== "string"
      ) {
        throw new Error("missing object hash");
      }
      const objectHash = object.value.result;
      const tree = await bridge.dispatch(
        "kernel.tree.create",
        {
          changes: {
            messages: Array.from({ length: 33 }, () => objectHash),
          },
          schemaId: "chunks",
        },
        instance
      );
      if (
        tree.kind !== "result" ||
        typeof tree.value !== "object" ||
        tree.value === null ||
        !("result" in tree.value) ||
        typeof tree.value.result !== "string" ||
        backend === undefined
      ) {
        throw new Error("missing tree hash or backend");
      }
      const hash = tree.value.result;
      await backend.transact(async (tx) => {
        const record = await tx.turnTrees.get(hash);
        expect(record?.createdAtMs).toBe(workerMs);
        const [path] = await tx.turnTreePaths.listByTurnTree(hash);
        if (
          path?.collectionKind !== "ordered" ||
          path.orderedEncoding !== "chunked"
        ) {
          throw new Error("missing chunked path");
        }
        const hashes = decodeDeterministicKernelRecord(
          path.orderedChunkListCbor
        );
        if (!Array.isArray(hashes) || hashes.length === 0) {
          throw new Error("missing chunks");
        }
        await Promise.all(
          hashes.map(async (chunkHash) => {
            if (typeof chunkHash !== "string") {
              throw new TypeError("invalid chunk hash");
            }
            const chunk = await tx.orderedPathChunks.get(chunkHash);
            expect(chunk?.createdAtMs).toBe(backendMs);
            expect(chunk?.createdAtMs).not.toBe(workerMs);
          })
        );
      });
    } finally {
      wallClock.mockRestore();
      factory.mockRestore();
      await bridge.destroyInstance(instance);
    }
  });
}

test("clock controls configure domains before backend initialization reads its clock", async () => {
  const original = hostSupport.createConfiguredBackend;
  const factory = spyOn(
    hostSupport,
    "createConfiguredBackend"
  ).mockImplementation(async (adapterConfig, options) => {
    expect(options?.now?.()).toBe(123);
    return await original(adapterConfig, options);
  });
  const bridge = createSyscallBindings(config);
  const instance = await bridge.createInstance();
  try {
    expect(
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "worker", nowMs: 456 },
        instance
      )
    ).toMatchObject({ kind: "result" });
    expect(
      await bridge.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: 123 },
        instance
      )
    ).toMatchObject({ kind: "result" });
    expect(factory).not.toHaveBeenCalled();
    expect(
      await bridge.dispatch(
        "kernel.store.put",
        { blob: { $bytes: "01" } },
        instance
      )
    ).toMatchObject({ kind: "result" });
    expect(factory).toHaveBeenCalledTimes(1);
  } finally {
    await bridge.destroyInstance(instance);
    factory.mockRestore();
  }
});

test("memory reports block fault mode as catalogued unsupported", async () => {
  const bridge = createSyscallBindings(config);
  const handle = await bridge.createInstance();
  try {
    expect(
      await bridge.dispatch(
        "kernel.fault.arm",
        { mode: "block", occurrence: 1, point: "before-commit", selector: {} },
        handle
      )
    ).toMatchObject({
      error: { code: "kernel_fault_point_unsupported" },
      kind: "error",
    });
  } finally {
    await bridge.destroyInstance(handle);
  }
});
