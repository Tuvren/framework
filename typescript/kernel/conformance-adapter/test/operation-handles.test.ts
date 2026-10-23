import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";

import { handleStdioAdapterLine } from "../../../../tools/conformance/adapter-protocol/stdio-host.ts";
import type { StdioConformanceAdapter } from "../../../../tools/conformance/adapter-protocol/stdio-host.ts";
import * as hostSupport from "../src/host-support.ts";
import { createSyscallBindings } from "../src/host-syscalls.ts";

test("two started native syscalls progress independently while one dependency is held", async () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const original = hostSupport.createConfiguredBackend;
  let held = false;
  const factory = spyOn(
    hostSupport,
    "createConfiguredBackend"
  ).mockImplementation(async (config, options) => {
    const opened = await original(config, options);
    const transact = opened.backend.transact.bind(opened.backend);
    spyOn(opened.backend, "transact").mockImplementation(async (body) => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return await transact(body);
    });
    return opened;
  });
  const bridge = createSyscallBindings({
    adapterId: "handles-test",
    backend: "memory",
    capabilities: ["kernel.syscall"],
  });
  const instance = await bridge.createInstance();
  const adapter = {
    ...bridge,
    dispatch: async (operation, input, _controls, handle) =>
      await bridge.dispatch(operation, input, handle),
    initialize: (packetId, planVersion) => ({
      adapterId: "handles-test",
      capabilities: [],
      packetId,
      planVersion,
    }),
  } satisfies StdioConformanceAdapter;
  let id = 0;
  const request = async (method: string, params: unknown): Promise<unknown> => {
    id += 1;
    const response = await handleStdioAdapterLine(
      adapter,
      JSON.stringify({ id, jsonrpc: "2.0", method, params })
    );
    if (
      typeof response !== "object" ||
      response === null ||
      !("result" in response)
    ) {
      throw new Error(JSON.stringify(response));
    }
    return response.result;
  };
  const start = async (hex: string): Promise<string> => {
    const value = await request("startOperation", {
      arguments: { blob: { $bytes: hex } },
      instance,
      operation: "kernel.store.put",
    });
    if (
      typeof value !== "object" ||
      value === null ||
      !("operationHandle" in value) ||
      typeof value.operationHandle !== "string"
    ) {
      throw new Error("missing handle");
    }
    return value.operationHandle;
  };
  try {
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "backend", nowMs: 100 },
      instance
    );
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "worker", nowMs: 100 },
      instance
    );
    const first = await start("01");
    await entered.promise;
    const second = await start("02");
    const secondOutcome = await request("awaitOperation", {
      operationHandle: second,
    });
    expect(secondOutcome).toMatchObject({ kind: "result" });
    release.resolve();
    const firstOutcome = await request("awaitOperation", {
      operationHandle: first,
    });
    expect(firstOutcome).toMatchObject({ kind: "result" });
    expect(firstOutcome).not.toEqual(secondOutcome);
  } finally {
    release.resolve();
    await bridge.destroyInstance(instance);
    factory.mockRestore();
  }
}, 3000);

test("cancelling a handle before native entry prevents writes and retains the reason", async () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const original = hostSupport.createConfiguredBackend;
  const factory = spyOn(
    hostSupport,
    "createConfiguredBackend"
  ).mockImplementation(async (config, options) => {
    entered.resolve();
    await release.promise;
    return await original(config, options);
  });
  const bridge = createSyscallBindings({
    adapterId: "cancel-test",
    backend: "memory",
    capabilities: ["kernel.syscall"],
  });
  const instance = await bridge.createInstance();
  try {
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "backend", nowMs: 100 },
      instance
    );
    await bridge.dispatch(
      "kernel.clock.set",
      { domain: "worker", nowMs: 100 },
      instance
    );
    const { operationHandle } = await bridge.startOperation(
      "kernel.store.put",
      { blob: { $bytes: "03" } },
      instance
    );
    await entered.promise;
    await bridge.cancelOperation(operationHandle, "cancel before native entry");
    release.resolve();
    const [cancelled] = await Promise.allSettled([
      bridge.awaitOperation(operationHandle),
    ]);
    expect(cancelled).toMatchObject({
      reason: new Error("cancel before native entry"),
      status: "rejected",
    });
    const hash = createHash("sha256").update(Uint8Array.of(3)).digest("hex");
    expect(
      await bridge.dispatch("kernel.store.has", { hash }, instance)
    ).toEqual({ kind: "result", value: { result: false } });
    await bridge.destroyInstance(instance);
    const [expired] = await Promise.allSettled([
      bridge.awaitOperation(operationHandle),
    ]);
    expect(expired).toMatchObject({
      reason: new Error("unknown operation handle"),
      status: "rejected",
    });
  } finally {
    release.resolve();
    await bridge.destroyInstance(instance);
    factory.mockRestore();
  }
}, 3000);
