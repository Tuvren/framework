import { expect, test } from "bun:test";
import path from "node:path";

import { JsonRpcAdapterClient } from "../../../../tools/conformance/harness/adapter-client.ts";
import { JsonRpcAdapterError } from "../../../../tools/conformance/harness/adapter-error.ts";

test("codec protocol preserves tagged records, native rejections, and malformed-frame errors", async () => {
  const client = new JsonRpcAdapterClient({
    command: ["bun", "typescript/kernel/conformance-adapter/src/host.ts"],
    cwd: path.resolve(import.meta.dirname, "../../../.."),
  });
  try {
    const initialized = await client.initialize(
      "tuvren.kernel.protocol",
      "0.1.0"
    );
    expect(initialized.capabilities).toContain("kernel.codec");
    const instance = await client.createInstance({});
    try {
      const record = {
        $map: [
          ["a", 1],
          ["b", { $bytes: "00ff" }],
        ],
      };
      const bytes = { $bytes: "a261610161624200ff" };
      expect(
        await client.dispatch("kernel.codec.encode", { record }, {}, instance)
      ).toEqual({ kind: "result", value: { result: bytes } });
      expect(
        await client.dispatch("kernel.codec.decode", { bytes }, {}, instance)
      ).toEqual({ kind: "result", value: { result: record } });
      expect(
        await client.dispatch(
          "kernel.codec.decode",
          { bytes: { $bytes: "1805" } },
          {},
          instance
        )
      ).toMatchObject({
        error: {
          code: "non_canonical_kernel_record_encoding",
          details: { canonicalHex: "05", receivedHex: "1805" },
        },
        kind: "error",
      });
      let failure: unknown;
      try {
        await client.dispatch(
          "kernel.codec.decode",
          { bytes: { $bytes: "GG" } },
          {},
          instance
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(JsonRpcAdapterError);
      if (failure instanceof JsonRpcAdapterError) {
        expect(failure.envelope.code).toBe("adapter_host_error");
      }
    } finally {
      await client.destroyInstance(instance);
    }
  } finally {
    await client.shutdown();
  }
});
