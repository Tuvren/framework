import { expect, test, spyOn } from "bun:test";

import { createSyscallBindings } from "../src/host-syscalls.ts";

const config = {
  adapterId: "clock-fault-contract",
  backend: "memory",
  capabilities: ["kernel.syscall"],
} as const;

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
