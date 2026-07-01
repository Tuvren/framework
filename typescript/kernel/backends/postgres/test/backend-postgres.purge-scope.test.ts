/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// KRT-BF006 — substrate partition drop for full tenant offboarding (kernel spec
// §9.4). The PostgreSQL backend realizes a Scope partition as its own snapshot
// row under the row-level isolation model (ADR-049), so dropping it deletes that
// row while every co-tenant Scope's row in the shared schema is left intact.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RuntimeBackend, TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_postgres_purge",
} satisfies TurnTreeSchema;

interface ClosablePostgresBackend extends RuntimeBackend {
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
}

async function closeBackend(backend: RuntimeBackend): Promise<void> {
  await (backend as ClosablePostgresBackend).destroy();
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("createPostgresBackend purgeScope", () => {
  test("drops the bound scope's snapshot row while a co-tenant scope sharing the schema survives", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const scopeA = createPostgresBackend({ ...baseOptions, scope: "tenant-a" });
    const scopeB = createPostgresBackend({ ...baseOptions, scope: "tenant-b" });

    try {
      const kernelA = createRuntimeKernel({ backend: scopeA });
      const kernelB = createRuntimeKernel({ backend: scopeB });
      const schemaIdA = await kernelA.schema.register(TEST_SCHEMA);
      await kernelA.thread.create("thread_a", schemaIdA, "branch_a");
      const schemaIdB = await kernelB.schema.register(TEST_SCHEMA);
      const threadB = await kernelB.thread.create(
        "thread_b",
        schemaIdB,
        "branch_b"
      );

      expect(scopeA.purgeScope).toBeDefined();
      await scopeA.purgeScope?.();

      // A fresh backend bound to the dropped Scope re-initializes an empty
      // partition: the offboarded thread is gone.
      const scopeAReopened = createPostgresBackend({
        ...baseOptions,
        scope: "tenant-a",
      });
      try {
        const kernelAReopened = createRuntimeKernel({
          backend: scopeAReopened,
        });
        expect(await kernelAReopened.thread.get("thread_a")).toBeNull();
      } finally {
        await closeBackend(scopeAReopened);
      }

      // Tenant B's row is untouched: its thread is still resolvable.
      const reloadedB = await kernelB.thread.get(threadB.threadId);
      expect(reloadedB?.threadId).toBe(threadB.threadId);
    } finally {
      await closeBackend(scopeA);
      await closeBackend(scopeB);
    }
  });
});
