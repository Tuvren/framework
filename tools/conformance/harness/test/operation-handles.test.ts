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
    if (input === "nan") return { kind: "result", value: { result: NaN } };
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

test("stdio answers inspectState while dispatch is blocked, once per id", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  const mark = client.markTranscript();
  const blocked = client.dispatch("probe", "block", {});
  try {
    expect(await client.inspectState({})).toEqual({ live: true });
    expect(await client.inspectState("release")).toEqual({ live: true });
    expect(await blocked).toEqual({
      kind: "result",
      value: { result: "block" },
    });
    const responses = client
      .framesSince(mark)
      .filter((frame) => frame.direction === "receive")
      .map((frame): unknown => JSON.parse(frame.frame));
    const ids = responses.map((frame) => {
      if (
        typeof frame !== "object" ||
        frame === null ||
        !("id" in frame) ||
        typeof frame.id !== "number"
      ) {
        throw new Error("missing response id");
      }
      return frame.id;
    });
    expect(ids.toSorted((left, right) => left - right)).toEqual([1, 2, 3]);
  } finally {
    await client.shutdown();
    await Promise.allSettled([blocked]);
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
