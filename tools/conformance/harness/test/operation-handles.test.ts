import { expect, test } from "bun:test";

import { JsonRpcAdapterClient } from "../adapter-client.ts";

const host = new URL("../../adapter-protocol/stdio-host.ts", import.meta.url)
  .pathname;

const script = `
import { serveStdioAdapter } from ${JSON.stringify(host)};
const gates = new Map();
const outcomes = new Map();
const dispatch = async (_operation, input) => {
    if (input === "block") await new Promise(resolve => gates.set("block", resolve));

    if (input === "invalid") return { kind: "result", value: { result: 1n } };
    if (input === "zero") return { kind: "result", value: { result: -0 } };
    if (input === "nan") return { kind: "result", value: { result: NaN } };
    if (input === "badOutcome") return { kind: "unexpected" };
    return { kind: "result", value: { result: input } };
};
await serveStdioAdapter({
  initialize: (packetId, planVersion) => ({ adapterId: "handles", capabilities: [], packetId, planVersion }),
  dispatch,
  startOperation: async (operation, input) => {
    const operationHandle = "operation-" + outcomes.size;
    outcomes.set(operationHandle, dispatch(operation, input));
    return { operationHandle };
  },
  awaitOperation: async operationHandle => await outcomes.get(operationHandle),
  inspectState: async query => { if (query === "release") gates.get("block")?.(); return { live: true }; }
});`;

test("legacy lifecycle reads and destruction wait for blocking dispatch", async () => {
  const ordered = `
    import { serveStdioAdapter } from ${JSON.stringify(host)};
    let pending = false;
    await serveStdioAdapter({
      initialize: (packetId,planVersion) => ({adapterId:"ordering",capabilities:[],packetId,planVersion}),
      dispatch: async () => { pending = true; await new Promise(resolve => setTimeout(resolve, 50)); pending = false; return {kind:"result",value:null}; },
      inspectState: async () => ({pending}),
      destroyInstance: async () => { if (pending) throw new Error("destroy overtook dispatch"); }
    });`;
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", ordered],
    cwd: process.cwd(),
    timeoutMs: 2000,
  });
  try {
    const pending = client.dispatch("probe", {}, {}, "instance");
    expect(await client.inspectState({}, "instance")).toEqual({
      pending: false,
    });
    await pending;
    const timedOut = Promise.allSettled([
      client.dispatch("probe", {}, {}, "instance", 10),
    ]);
    await timedOut;
    await expect(client.destroyInstance("instance")).resolves.toBeUndefined();
  } finally {
    await client.shutdown();
  }
});

test("a malformed await outcome is rejected before assertion evaluation", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  try {
    const started = await client.startOperation(
      "probe",
      "badOutcome",
      "instance"
    );
    await expect(
      client.awaitOperation(started.operationHandle)
    ).rejects.toThrow(
      "adapter awaitOperation returned invalid OperationOutcome"
    );
  } finally {
    await client.shutdown();
  }
});

test("stdio keeps two operation handles and inspectState independent of a blocked await", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  let blocked: Promise<unknown> | undefined;
  try {
    const first = await client.startOperation("probe", "block", "instance");
    blocked = client.awaitOperation(first.operationHandle);
    const second = await client.startOperation("probe", "ready", "instance");
    expect(await client.awaitOperation(second.operationHandle)).toEqual({
      kind: "result",
      value: { result: "ready" },
    });
    expect(await client.inspectState({})).toEqual({ live: true });
    await client.inspectState("release");
    expect(await blocked).toEqual({
      kind: "result",
      value: { result: "block" },
    });
  } finally {
    await client.shutdown();
    await Promise.allSettled(blocked === undefined ? [] : [blocked]);
  }
});

test.each(["invalid", "nan"])(
  "stdio emits one correlated serialization error for %s and remains usable",
  async (input) => {
    const client = new JsonRpcAdapterClient({
      command: ["bun", "--eval", script],
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    const mark = client.markTranscript();
    try {
      await expect(client.dispatch("probe", input, {})).rejects.toThrow(
        "adapter_response_serialization_failed"
      );
      expect(await client.inspectState({})).toEqual({ live: true });
      const frames = client
        .framesSince(mark)
        .filter((frame) => frame.direction === "receive")
        .map((frame): unknown => JSON.parse(frame.frame));
      expect(frames).toMatchObject([{ id: 1 }, { id: 2 }]);
    } finally {
      await client.shutdown();
    }
  }
);

test("client drives real catalogued operations through handles and keeps native outcomes after cancel", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "typescript/kernel/conformance-adapter/src/host.ts"],
    cwd: process.cwd(),
    timeoutMs: 2000,
  });
  try {
    await client.initialize("tuvren.kernel.protocol", "0.1.0");
    const instance = await client.createInstance({});
    try {
      await client.dispatch(
        "kernel.clock.set",
        { domain: "backend", nowMs: 100 },
        {},
        instance
      );
      await client.dispatch(
        "kernel.clock.set",
        { domain: "worker", nowMs: 100 },
        {},
        instance
      );
      const first = await client.startOperation(
        "kernel.store.put",
        { blob: { $bytes: "01" } },
        instance
      );
      const second = await client.startOperation(
        "kernel.store.put",
        { blob: { $bytes: "02" } },
        instance
      );
      expect(first.operationHandle).not.toBe(second.operationHandle);
      const outcome = await client.awaitOperation(second.operationHandle);
      expect(outcome).toMatchObject({ kind: "result" });
      await client.cancelOperation(second.operationHandle, "already complete");
      expect(await client.awaitOperation(second.operationHandle)).toEqual(
        outcome
      );
      expect(await client.awaitOperation(first.operationHandle)).toMatchObject({
        kind: "result",
      });
      await expect(client.awaitOperation("missing")).rejects.toThrow(
        "unknown operation handle"
      );
    } finally {
      await client.destroyInstance(instance);
    }
  } finally {
    await client.shutdown();
  }
});

test("legacy stdio responses preserve JSON serialization of negative zero", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  try {
    expect(await client.dispatch("probe", "zero", {})).toEqual({
      kind: "result",
      value: { result: 0 },
    });
  } finally {
    await client.shutdown();
  }
});

test("real stdio host cancels a gated native operation after its entry receipt", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "typescript/kernel/conformance-adapter/src/host.ts"],
    cwd: process.cwd(),
    timeoutMs: 3000,
  });
  try {
    await client.initialize("tuvren.kernel.protocol", "0.1.0");
    const instance = await client.createInstance({});
    try {
      for (const domain of ["backend", "worker"]) {
        await client.dispatch(
          "kernel.clock.set",
          { domain, nowMs: 100 },
          {},
          instance
        );
      }
      await client.dispatch(
        "kernel.barrier.arm",
        {
          barrierId: "cancel",
          seam: "kernel.persistence.before-transact",
          participants: ["first", "second"],
        },
        {},
        instance
      );
      const first = await client.startOperation(
        "kernel.store.put",
        { blob: { $bytes: "06" } },
        instance
      );
      const second = await client.startOperation(
        "kernel.store.put",
        { blob: { $bytes: "07" } },
        instance
      );
      for (const started of [first, second]) {
        expect(
          await client.dispatch(
            "kernel.barrier.wait",
            {
              barrierId: "cancel",
              operationHandle: started.operationHandle,
              timeoutMs: 1000,
            },
            {},
            instance
          )
        ).toMatchObject({
          kind: "result",
          value: { result: { operationHandle: started.operationHandle } },
        });
      }
      await client.cancelOperation(first.operationHandle, "cancel at gate");
      await client.dispatch(
        "kernel.barrier.release",
        {
          barrierId: "cancel",
          operationHandles: [first.operationHandle, second.operationHandle],
        },
        {},
        instance
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          client.awaitOperation(first.operationHandle)
        ).rejects.toMatchObject({
          envelope: { code: "adapter_host_error", message: "cancel at gate" },
        });
      }
      expect(await client.awaitOperation(second.operationHandle)).toMatchObject(
        { kind: "result" }
      );
    } finally {
      await client.destroyInstance(instance);
    }
  } finally {
    await client.shutdown();
  }
});

test("catalogued stdio responses reject negative zero while legacy responses retain their behavior", async () => {
  const client = new JsonRpcAdapterClient({
    command: [
      "bun",
      "--eval",
      script.replace(
        "  dispatch,",
        '  dispatch, isLosslessRequest: (_method, params) => params?.operation === "catalogued",'
      ),
    ],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  try {
    await expect(client.dispatch("catalogued", "zero", {})).rejects.toThrow(
      "adapter_response_serialization_failed"
    );
  } finally {
    await client.shutdown();
  }
});

test("real stdio destruction cancels a named barrier-held operation before cleanup", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "typescript/kernel/conformance-adapter/src/host.ts"],
    cwd: process.cwd(),
    timeoutMs: 3000,
  });
  try {
    const instance = await client.createInstance({});
    for (const domain of ["backend", "worker"]) {
      await client.dispatch(
        "kernel.clock.set",
        { domain, nowMs: 100 },
        {},
        instance
      );
    }
    await client.dispatch(
      "kernel.barrier.arm",
      {
        barrierId: "destroy",
        seam: "kernel.persistence.before-transact",
        participants: ["first", "second"],
      },
      {},
      instance
    );
    const first = await client.startOperation(
      "kernel.store.put",
      { blob: { $bytes: "08" } },
      instance
    );
    await client.dispatch(
      "kernel.barrier.wait",
      {
        barrierId: "destroy",
        operationHandle: first.operationHandle,
        timeoutMs: 1000,
      },
      {},
      instance
    );
    const pending = client.awaitOperation(first.operationHandle).then(
      (value) => ({ status: "fulfilled", value }),
      (error: unknown) => ({ status: "rejected", error })
    );
    await expect(client.destroyInstance(instance)).resolves.toBeUndefined();
    expect(await pending).toMatchObject({
      status: "rejected",
      error: {
        envelope: {
          code: "adapter_host_error",
          message: "adapter instance destroyed",
        },
      },
    });
  } finally {
    await client.shutdown();
  }
});
