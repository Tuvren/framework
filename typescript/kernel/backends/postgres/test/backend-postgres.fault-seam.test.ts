import { afterAll, test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";

import {
  createDurableFaultControl,
  createFaultInjectingBackend,
  createStoredObjectRecord,
} from "@tuvren/kernel-testkit";

import * as publicApi from "../src/index.js";
import {
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

test("public PostgreSQL construction exposes no commit-hook installation path", async () => {
  deepStrictEqual(Object.keys(publicApi), [
    "createPostgresBackend",
    "destroyPostgresBackend",
  ]);
  const backend = publicApi.createPostgresBackend(
    createPostgresTestBackendOptions()
  );
  const installed: string[] = [];
  let calls = 0;
  const hooks = {
    beforeCommit: async () => {
      calls += 1;
      await Promise.resolve();
    },
  };
  try {
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
  } finally {
    await backend.close();
  }
});

for (const point of ["before-commit", "after-commit-before-ack"] as const) {
  test(`PostgreSQL test seam injects ${point} without affecting the public backend`, async () => {
    const backend = publicApi.createPostgresBackend(
      createPostgresTestBackendOptions()
    );
    const control = createDurableFaultControl(backend, async () => {
      await Promise.resolve();
    });
    try {
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
      const exists = await backend.transact(
        async (tx) => await tx.objects.has(record.hash)
      );
      strictEqual(exists, point === "after-commit-before-ack");
      const legacyRecord = await createStoredObjectRecord(
        new TextEncoder().encode(`legacy-${point}`),
        1
      );
      const legacy = createFaultInjectingBackend(backend, {
        point,
        policy: "once",
      });
      await rejects(
        legacy.transact(async (tx) => {
          await tx.objects.put(legacyRecord);
        }),
        {
          code: "kernel_persistence_fault_injected",
        }
      );
      const legacyExists = await backend.transact(
        async (tx) => await tx.objects.has(legacyRecord.hash)
      );
      strictEqual(legacyExists, point === "after-commit-before-ack");
    } finally {
      await backend.close();
    }
  });
}
