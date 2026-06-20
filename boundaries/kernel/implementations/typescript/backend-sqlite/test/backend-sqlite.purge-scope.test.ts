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
// §9.4). The SQLite backend realizes a Scope partition as its own database file
// (file-per-scope, ADR-049), so dropping it removes that file while every
// co-tenant Scope's sibling file is left intact.

import { ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, describe, test } from "node:test";
import type { TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_sqlite_purge",
} satisfies TurnTreeSchema;

const openBackends: { close(): Promise<void> }[] = [];

after(async () => {
  for (const backend of openBackends) {
    await backend.close();
  }
});

async function seedThread(
  backend: ReturnType<typeof createSqliteBackend>,
  threadId: string,
  branchId: string
): Promise<string> {
  const kernel = createRuntimeKernel({ backend });
  const schemaId = await kernel.schema.register(TEST_SCHEMA);
  await kernel.thread.create(threadId, schemaId, branchId);
  return threadId;
}

describe("createSqliteBackend purgeScope", () => {
  test("drops the bound scope's database file while a co-tenant scope's sibling file survives", async () => {
    // Tenant A binds the default Scope (its file is the base path verbatim);
    // tenant B binds a named Scope (a deterministic sibling file). They share a
    // base path but address independent files.
    const basePath = createTempDatabasePath();
    const backendA = createSqliteBackend({ databasePath: basePath });
    const backendB = createSqliteBackend({
      databasePath: basePath,
      scope: "tenant-b",
    });
    openBackends.push(backendB);

    await seedThread(backendA, "thread_a", "branch_a");
    const threadIdB = await seedThread(backendB, "thread_b", "branch_b");

    // Tenant A's file exists before offboarding.
    ok(existsSync(basePath));

    ok(backendA.purgeScope !== undefined);
    await backendA.purgeScope?.();

    // The partition drop removed tenant A's file.
    strictEqual(existsSync(basePath), false);

    // Reopening tenant A at the same path yields a fresh, empty partition.
    const backendAReopened = createSqliteBackend({ databasePath: basePath });
    openBackends.push(backendAReopened);
    const kernelAReopened = createRuntimeKernel({ backend: backendAReopened });
    strictEqual(await kernelAReopened.thread.get("thread_a"), null);

    // Tenant B is wholly untouched: its thread is still resolvable.
    const kernelB = createRuntimeKernel({ backend: backendB });
    const reloadedB = await kernelB.thread.get(threadIdB);
    strictEqual(reloadedB?.threadId, threadIdB);
  });
});
