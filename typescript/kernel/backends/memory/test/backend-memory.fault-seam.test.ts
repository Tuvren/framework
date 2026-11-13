import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createDurableFaultControl,
  createFaultInjectingBackend,
  createStoredObjectRecord,
} from "@tuvren/kernel-testkit";

import * as publicApi from "../src/index.js";

void test("public memory construction exposes no commit-hook installation path", async () => {
  deepStrictEqual(Object.keys(publicApi).toSorted(), [
    "createMemoryBackend",
    "createMemoryScopeStore",
  ]);
  const backend = publicApi.createMemoryBackend();
  const installed: string[] = [];
  let calls = 0;
  const hooks = {
    beforeCommit: async () => {
      calls += 1;
      await Promise.resolve();
    },
  };
  for (const key of Reflect.ownKeys(backend)) {
    const value: unknown = Reflect.get(backend, key);
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const setter: unknown = Reflect.get(value, "setFaultHooks");
    if (typeof setter === "function") {
      installed.push(String(key));
      setter.call(value, hooks);
    }
    if (key === "faultState" && Reflect.has(value, "hooks")) {
      installed.push(key);
      Reflect.set(value, "hooks", hooks);
    }
  }
  await backend.transact(async () => {
    await Promise.resolve();
  });
  strictEqual(calls, 0);
  deepStrictEqual(installed, []);
  deepStrictEqual(Object.getOwnPropertySymbols(backend), []);
  strictEqual("setFaultHooks" in backend, false);
});

for (const point of ["before-commit", "after-commit-before-ack"] as const) {
  void test(`memory test seam injects ${point} without affecting the public backend`, async () => {
    const store = publicApi.createMemoryScopeStore();
    const backend = publicApi.createMemoryBackend({ store });
    const control = createDurableFaultControl(backend, async () => {
      await Promise.resolve();
    });
    const record = await createStoredObjectRecord(
      new TextEncoder().encode(point),
      1
    );
    const { token } = control.arm(point, {}, 1, "throw");
    await backend.transact(async () => {
      await Promise.resolve();
    });
    await rejects(
      control.backend.transact(async (tx) => {
        await tx.objects.put(record);
      }),
      { code: "kernel_persistence_fault_injected", details: { point, token } }
    );
    const recovered = publicApi.createMemoryBackend({ store });
    deepStrictEqual(
      await recovered.transact(async (tx) => await tx.objects.get(record.hash)),
      point === "after-commit-before-ack" ? record : null
    );
    const legacyRecord = await createStoredObjectRecord(
      new TextEncoder().encode(`legacy-${point}`),
      1
    );
    const legacyToken = `legacy-${point}`;
    const legacy = createFaultInjectingBackend(backend, {
      point,
      policy: "once",
      token: legacyToken,
    });
    await rejects(
      legacy.transact(async (tx) => {
        await tx.objects.put(legacyRecord);
      }),
      {
        code: "kernel_persistence_fault_injected",
        details: { point, token: legacyToken },
      }
    );
    deepStrictEqual(
      await recovered.transact(
        async (tx) => await tx.objects.get(legacyRecord.hash)
      ),
      point === "after-commit-before-ack" ? legacyRecord : null
    );
  });
}
