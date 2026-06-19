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
import { DEFAULT_SCOPE } from "@tuvren/core";
import type {
  RuntimeBackend,
  StoredBranch,
  StoredThread,
} from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import postgres, { type Sql } from "postgres";
import type { PostgresBackendOptions } from "../src/index.js";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

interface ClosablePostgresBackend extends RuntimeBackend {
  destroy(options?: { dropSchema?: boolean }): Promise<void>;
}

// Closes a backend's connection pool without dropping its schema, so two
// backends sharing a schema can each be closed independently before the
// afterAll teardown drops the schema.
async function closeBackend(backend: RuntimeBackend): Promise<void> {
  await (backend as ClosablePostgresBackend).destroy();
}

function createAdminClient(options: PostgresBackendOptions): Sql {
  return postgres({
    database: options.database,
    host: options.host,
    idle_timeout: 1,
    max: 1,
    onnotice: () => undefined,
    port: options.port,
    prepare: false,
    username: options.username,
  });
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// Seeds a minimal thread (schema + genesis turn tree/node + thread) so
// enumeration isolation can be asserted via threads.list.
async function seedThread(
  backend: RuntimeBackend,
  threadId: string,
  base: number
): Promise<string> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, base);
  const manifest = { "context.manifest": null, messages: [] as string[] };
  const turnTree = await createStoredTurnTreeRecord(schema, manifest, base + 1);
  const turnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: base + 2,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: base + 3,
    rootTurnNodeHash: turnNode.hash,
    schemaId: schema.schemaId,
    threadId,
  };

  await backend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, manifest)
    );
    await tx.turnNodes.put(turnNode);
    await tx.threads.put(thread);
  });

  return threadId;
}

// The full record set the Durable-Read Surface composes over (KRT-BE006): a
// branch and its genesis turn node, turn tree, ordered message path, and the
// message object itself, so a co-tenant scope can be proven blind to all of it.
interface SeededBranch {
  branchId: string;
  headTurnNodeHash: string;
  messageHash: string;
  threadId: string;
  turnTreeHash: string;
}

async function seedBranchWithMessage(
  backend: RuntimeBackend,
  threadId: string,
  branchId: string,
  base: number
): Promise<SeededBranch> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, base);
  const messageObject = await createStoredObjectRecord(
    new Uint8Array([1, 2, 3, 4]),
    base + 1
  );
  const manifest = {
    "context.manifest": null,
    messages: [messageObject.hash],
  };
  const turnTree = await createStoredTurnTreeRecord(schema, manifest, base + 2);
  const turnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: base + 3,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: base + 4,
    rootTurnNodeHash: turnNode.hash,
    schemaId: schema.schemaId,
    threadId,
  };
  const branch: StoredBranch = {
    branchId,
    createdAtMs: base + 5,
    headTurnNodeHash: turnNode.hash,
    threadId,
    updatedAtMs: base + 5,
  };

  await backend.transact(async (tx) => {
    await tx.schemas.put(schemaRecord);
    await tx.objects.put(messageObject);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, manifest)
    );
    await tx.turnNodes.put(turnNode);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
  });

  return {
    branchId,
    headTurnNodeHash: turnNode.hash,
    messageHash: messageObject.hash,
    threadId,
    turnTreeHash: turnTree.hash,
  };
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres scope isolation (KRT-BE005)", () => {
  test("content stored under one scope is not retrievable or existence-checkable through another scope sharing the schema", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const scopeA = createPostgresBackend({ ...baseOptions, scope: "tenant-a" });
    const scopeB = createPostgresBackend({ ...baseOptions, scope: "tenant-b" });

    const record = await createStoredObjectRecord(new Uint8Array([1, 2, 3]), 1);

    await scopeA.transact(async (tx) => {
      await tx.objects.put(record);
    });

    await scopeB.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(false);
      expect(await tx.objects.get(record.hash)).toBeNull();
    });

    await scopeA.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
      const stored = await tx.objects.get(record.hash);
      expect(Array.from(stored?.bytes ?? [])).toEqual([1, 2, 3]);
    });

    await closeBackend(scopeA);
    await closeBackend(scopeB);
  });

  test("enumeration is scope-confined: a co-tenant scope cannot list this scope's threads", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const scopeA = createPostgresBackend({ ...baseOptions, scope: "tenant-a" });
    const scopeB = createPostgresBackend({ ...baseOptions, scope: "tenant-b" });

    const threadId = await seedThread(scopeA, "thread_a", 100);

    await scopeB.transact(async (tx) => {
      const list = tx.threads.list;
      expect(list).toBeDefined();
      const listed = await list?.({});
      expect(listed?.threads ?? []).toEqual([]);
      expect(await tx.threads.get(threadId)).toBeNull();
    });

    await scopeA.transact(async (tx) => {
      const list = tx.threads.list;
      expect(list).toBeDefined();
      const listed = await list?.({});
      expect((listed?.threads ?? []).map((thread) => thread.threadId)).toEqual([
        threadId,
      ]);
    });

    await closeBackend(scopeA);
    await closeBackend(scopeB);
  });

  test("identical content under two scopes is two independent durable objects (no cross-scope dedup)", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const scopeA = createPostgresBackend({ ...baseOptions, scope: "tenant-a" });
    const scopeB = createPostgresBackend({ ...baseOptions, scope: "tenant-b" });

    const recordA = await createStoredObjectRecord(new Uint8Array([7, 7]), 1);
    const recordB = await createStoredObjectRecord(new Uint8Array([7, 7]), 1);
    expect(recordA.hash).toBe(recordB.hash);

    await scopeA.transact(async (tx) => {
      await tx.objects.put(recordA);
    });
    // Scope B can independently store the identical content; it does not collide
    // with scope A and is invisible across the scope boundary.
    await scopeB.transact(async (tx) => {
      expect(await tx.objects.has(recordB.hash)).toBe(false);
      await tx.objects.put(recordB);
      expect(await tx.objects.has(recordB.hash)).toBe(true);
    });

    await closeBackend(scopeA);
    await closeBackend(scopeB);
  });

  test("two backends bound to the same scope and schema share that scope's durable state across re-instantiation", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const record = await createStoredObjectRecord(new Uint8Array([9]), 1);

    const first = createPostgresBackend({ ...baseOptions, scope: "tenant-x" });
    await first.transact(async (tx) => {
      await tx.objects.put(record);
    });
    await closeBackend(first);

    const second = createPostgresBackend({ ...baseOptions, scope: "tenant-x" });
    await second.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
    });
    await closeBackend(second);
  });

  test("two scopes initializing the same fresh schema concurrently both succeed and stay isolated", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const scopeA = createPostgresBackend({ ...baseOptions, scope: "tenant-a" });
    const scopeB = createPostgresBackend({ ...baseOptions, scope: "tenant-b" });

    const recordA = await createStoredObjectRecord(new Uint8Array([10]), 1);
    const recordB = await createStoredObjectRecord(new Uint8Array([20]), 2);

    // Force concurrent first-touch initialization of the shared schema: the two
    // scoped backends race `ensureInitialized`, which the schema-keyed advisory
    // lock serializes so neither init collides on the idempotent DDL.
    await Promise.all([
      scopeA.transact(async (tx) => {
        await tx.objects.put(recordA);
      }),
      scopeB.transact(async (tx) => {
        await tx.objects.put(recordB);
      }),
    ]);

    await scopeA.transact(async (tx) => {
      expect(await tx.objects.has(recordA.hash)).toBe(true);
      expect(await tx.objects.has(recordB.hash)).toBe(false);
    });
    await scopeB.transact(async (tx) => {
      expect(await tx.objects.has(recordB.hash)).toBe(true);
      expect(await tx.objects.has(recordA.hash)).toBe(false);
    });

    await closeBackend(scopeA);
    await closeBackend(scopeB);
  });

  test("the default scope is just another row: it is isolated from a named scope sharing the schema", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const defaultRecord = await createStoredObjectRecord(
      new Uint8Array([1]),
      1
    );
    const scopedRecord = await createStoredObjectRecord(new Uint8Array([2]), 2);

    const defaultBackend = createPostgresBackend(baseOptions);
    const scopedBackend = createPostgresBackend({
      ...baseOptions,
      scope: "tenant-a",
    });

    await defaultBackend.transact(async (tx) => {
      await tx.objects.put(defaultRecord);
    });
    await scopedBackend.transact(async (tx) => {
      expect(await tx.objects.has(defaultRecord.hash)).toBe(false);
      await tx.objects.put(scopedRecord);
    });
    await defaultBackend.transact(async (tx) => {
      expect(await tx.objects.has(defaultRecord.hash)).toBe(true);
      expect(await tx.objects.has(scopedRecord.hash)).toBe(false);
    });

    await closeBackend(defaultBackend);
    await closeBackend(scopedBackend);
  });

  test("migrates a legacy single-scope snapshot table to the scope-partitioned shape, preserving its data as the default scope", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const record = await createStoredObjectRecord(new Uint8Array([4, 2]), 1);
    const schemaName = baseOptions.schemaName ?? "public";
    const snapshotsTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier(
      "backend_postgres_snapshots"
    )}`;
    const migrationsTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier(
      "backend_postgres_migrations"
    )}`;

    // Seed the scoped backend (default scope) with a record, then downgrade the
    // table in place to the legacy pre-scope shape to simulate a database that
    // predates row-level scope isolation.
    const seeded = createPostgresBackend(baseOptions);
    await seeded.transact(async (tx) => {
      await tx.objects.put(record);
    });
    await closeBackend(seeded);

    const admin = createAdminClient(baseOptions);
    try {
      await admin.unsafe(
        `ALTER TABLE ${snapshotsTable} DROP CONSTRAINT backend_postgres_snapshots_pkey`
      );
      await admin.unsafe(`ALTER TABLE ${snapshotsTable} DROP COLUMN scope`);
      await admin.unsafe(
        `ALTER TABLE ${snapshotsTable} ADD CONSTRAINT backend_postgres_snapshots_pkey PRIMARY KEY (snapshot_id)`
      );
      await admin.unsafe(`DELETE FROM ${migrationsTable} WHERE name = $1`, [
        "0002_scope_partition.sql",
      ]);
    } finally {
      await admin.end({ timeout: 0 });
    }

    // Reopening with the default scope must migrate the legacy table and surface
    // the pre-scope data as the default scope's snapshot.
    const migrated = createPostgresBackend(baseOptions);
    await migrated.transact(async (tx) => {
      expect(await tx.objects.has(record.hash)).toBe(true);
    });
    await closeBackend(migrated);

    const verify = createAdminClient(baseOptions);
    try {
      const scopeColumns = await verify.unsafe<Array<{ column_name: string }>>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = 'backend_postgres_snapshots'
            AND column_name = 'scope'`,
        [schemaName]
      );
      expect(scopeColumns.length).toBe(1);

      const rows = await verify.unsafe<Array<{ scope: string }>>(
        `SELECT scope FROM ${snapshotsTable} ORDER BY scope`
      );
      expect(rows.map((row) => row.scope)).toEqual([DEFAULT_SCOPE]);

      const migrationRows = await verify.unsafe<Array<{ name: string }>>(
        `SELECT name FROM ${migrationsTable} ORDER BY name`
      );
      expect(migrationRows.map((row) => row.name)).toEqual([
        "0001_initial_schema.sql",
        "0002_scope_partition.sql",
      ]);
    } finally {
      await verify.end({ timeout: 0 });
    }
  });

  test("every durable-identity record the Durable-Read Surface reads is scope-confined (KRT-BE006)", async () => {
    const baseOptions = createPostgresTestBackendOptions();
    const scopeA = createPostgresBackend({ ...baseOptions, scope: "tenant-a" });
    const scopeB = createPostgresBackend({ ...baseOptions, scope: "tenant-b" });

    const seeded = await seedBranchWithMessage(
      scopeA,
      "thread_a",
      "branch_a",
      1
    );

    // Scope B observes none of the thread, branch, node, tree, path, or
    // message records.
    await scopeB.transact(async (tx) => {
      expect(await tx.threads.get(seeded.threadId)).toBeNull();
      expect(await tx.branches.get(seeded.branchId)).toBeNull();
      expect(await tx.branches.listByThread(seeded.threadId)).toEqual([]);
      expect(await tx.turnNodes.get(seeded.headTurnNodeHash)).toBeNull();
      expect(await tx.turnTrees.get(seeded.turnTreeHash)).toBeNull();
      expect(
        await tx.turnTreePaths.listByTurnTree(seeded.turnTreeHash)
      ).toEqual([]);
      expect(await tx.objects.has(seeded.messageHash)).toBe(false);
      expect(await tx.objects.get(seeded.messageHash)).toBeNull();
    });

    // Scope A observes its own complete record set.
    await scopeA.transact(async (tx) => {
      expect((await tx.threads.get(seeded.threadId))?.threadId).toBe(
        "thread_a"
      );
      expect((await tx.branches.get(seeded.branchId))?.branchId).toBe(
        "branch_a"
      );
      expect(
        (await tx.branches.listByThread(seeded.threadId)).map((b) => b.branchId)
      ).toEqual(["branch_a"]);
      expect((await tx.turnNodes.get(seeded.headTurnNodeHash))?.hash).toBe(
        seeded.headTurnNodeHash
      );
      expect((await tx.turnTrees.get(seeded.turnTreeHash))?.hash).toBe(
        seeded.turnTreeHash
      );
      expect(
        (await tx.turnTreePaths.listByTurnTree(seeded.turnTreeHash)).length
      ).toBeGreaterThan(0);
      expect(await tx.objects.has(seeded.messageHash)).toBe(true);
    });

    await closeBackend(scopeA);
    await closeBackend(scopeB);
  });

  test("rejects an empty scope binding at construction", () => {
    const baseOptions = createPostgresTestBackendOptions();
    expect(() => createPostgresBackend({ ...baseOptions, scope: "" })).toThrow(
      TypeError
    );
  });
});
