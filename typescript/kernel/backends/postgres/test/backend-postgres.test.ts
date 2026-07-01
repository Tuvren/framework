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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RuntimeBackend } from "@tuvren/kernel-protocol";
import {
  createStoredObjectRecord,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "@tuvren/kernel-testkit";
import type { Sql } from "postgres";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

registerBackendConformanceSuite({
  createBackend: () =>
    createPostgresBackend(createPostgresTestBackendOptions()),
  suiteName: "@tuvren/backend-postgres shared conformance",
  testApi: { describe, test },
});

registerBackendInvariantSuite({
  createBackend: () =>
    createPostgresBackend(createPostgresTestBackendOptions()),
  suiteName: "@tuvren/backend-postgres shared invariants",
  testApi: { describe, test },
});

registerBackendRecoverySuite({
  createBackend: () =>
    createPostgresBackend(createPostgresTestBackendOptions()),
  suiteName: "@tuvren/backend-postgres shared recovery",
  testApi: { describe, test },
});

describe("@tuvren/backend-postgres", () => {
  test("persists records across backend re-instantiation within the same schema", async () => {
    const options = createPostgresTestBackendOptions();
    const firstBackend = createPostgresBackend(options);
    const objectRecord = await createStoredObjectRecord(
      new Uint8Array([1, 2, 3]),
      1
    );

    await firstBackend.transact(async (tx) => {
      await tx.objects.put(objectRecord);
    });

    const reopenedBackend = createPostgresBackend(options);

    await reopenedBackend.transact(async (tx) => {
      expect(await tx.objects.get(objectRecord.hash)).toEqual(objectRecord);
    });
  });

  test("retries initialization after a transient bootstrap failure", async () => {
    interface TestablePostgresBackend extends RuntimeBackend {
      destroy(options?: { dropSchema?: boolean }): Promise<void>;
      readonly sql: Sql;
    }

    const backend = createPostgresBackend(
      createPostgresTestBackendOptions()
    ) as TestablePostgresBackend;
    const originalBegin = backend.sql.begin.bind(backend.sql);
    let attempts = 0;

    backend.sql.begin = (async (...args: Parameters<Sql["begin"]>) => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("transient bootstrap failure");
      }

      return await originalBegin(...args);
    }) as Sql["begin"];

    try {
      expect(await backend.health()).toEqual({
        ok: false,
        reason: "transient bootstrap failure",
      });
      expect(await backend.health()).toEqual({ ok: true });
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
