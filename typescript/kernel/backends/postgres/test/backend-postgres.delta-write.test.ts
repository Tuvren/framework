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
import { createStoredObjectRecord } from "@tuvren/kernel-testkit";
import type { Sql } from "postgres";
import { createPostgresBackend } from "../src/index.js";
import { RELATIONAL_REQUIRED_TABLES } from "../src/lib/postgres-schema.js";
import { quoteIdentifier } from "../src/lib/postgres-sql.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createAdminClient,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

/**
 * KRT-BK012: issue #110 Gherkin scenario 2 ("the write does not re-encode or
 * re-write the other 9,999 objects") proven deterministically at the
 * durable-state level instead of by timing.
 *
 * Every row a PostgreSQL transaction physically writes carries that
 * transaction's `xmin` (its transaction id). A single-object write that is
 * genuinely delta-proportional touches exactly one row across the entire
 * relational schema, no matter how many pre-existing objects already share
 * the scope: the row it inserts into `objects`. If the write path ever
 * regressed into re-touching unrelated rows (a full-scope rewrite, a stray
 * update elsewhere), this test would see more than one row bearing the
 * write transaction's `xmin`.
 */

function requireSchemaName(
  options: ReturnType<typeof createPostgresTestBackendOptions>
): string {
  if (options.schemaName === undefined) {
    throw new Error("expected a schema name on the test backend options");
  }

  return options.schemaName;
}

// Deterministic, unique-per-index byte content so every seeded object hashes
// to a distinct `objects.hash` (StoredObject identity is content-addressed).
// Encodes `index` as four big-endian base-256 digits (arithmetic, not
// bitwise, per this repo's lint rules) plus a constant salt byte.
function objectBytesForIndex(index: number): Uint8Array {
  const byte3 = Math.floor(index / 16_777_216) % 256;
  const byte2 = Math.floor(index / 65_536) % 256;
  const byte1 = Math.floor(index / 256) % 256;
  const byte0 = index % 256;

  return new Uint8Array([byte3, byte2, byte1, byte0, 0xdc]);
}

// Inserts `count` distinct objects into the backend's scope across
// `count / batchSize` `transact()` calls, each issuing `batchSize`
// `tx.objects.put()` calls, so setup approximates realistic write traffic
// without paying one transaction (and one advisory-lock acquisition) per
// object.
async function seedObjects(
  backend: ReturnType<typeof createPostgresBackend>,
  count: number,
  batchSize: number
): Promise<void> {
  const records = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      createStoredObjectRecord(objectBytesForIndex(index), 1)
    )
  );

  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    await backend.transact(async (tx) => {
      for (const record of batch) {
        await tx.objects.put(record);
      }
    });
  }
}

// Reads the `xmin` (transaction id) that wrote `hash`'s row in `objects`.
async function readObjectRowTransactionId(
  admin: Sql,
  schemaName: string,
  scope: string,
  hash: string
): Promise<string> {
  const objectsTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier("objects")}`;
  const rows = await admin.unsafe<Array<{ tx: string }>>(
    `SELECT xmin::text AS tx FROM ${objectsTable} WHERE scope = $1 AND hash = $2`,
    [scope, hash]
  );
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`expected an objects row for hash ${hash}`);
  }

  return row.tx;
}

// Counts, across every family table in the relational schema, how many rows
// carry `transactionId` as their `xmin` within `scope`. A delta-proportional
// single-object write must total exactly 1 (the one row it inserted into
// `objects`) regardless of how many other rows already exist in the scope.
async function countRowsWrittenByTransaction(
  admin: Sql,
  schemaName: string,
  scope: string,
  transactionId: string
): Promise<Record<string, number>> {
  const countsByTable: Record<string, number> = {};

  for (const table of RELATIONAL_REQUIRED_TABLES) {
    const qualified = `${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`;
    const rows = await admin.unsafe<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM ${qualified} WHERE scope = $1 AND xmin::text = $2`,
      [scope, transactionId]
    );
    countsByTable[table] = Number(rows[0]?.n ?? "0");
  }

  return countsByTable;
}

function totalRows(countsByTable: Record<string, number>): number {
  return Object.values(countsByTable).reduce((sum, count) => sum + count, 0);
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

// The two cases only differ in scale (how many pre-existing objects share
// the scope) and the resulting seed batching/timeout budget; the assertions
// under test — exactly one row total, and that row landing in `objects` —
// are identical, so both scales run through one parameterized body instead
// of two copies that could silently drift apart.
interface DeltaWriteCase {
  readonly description: string;
  readonly scope: string;
  readonly seedBatchSize: number;
  readonly seedCount: number;
  readonly timeoutMs: number;
}

const DELTA_WRITE_CASES: readonly DeltaWriteCase[] = [
  {
    description:
      "writing one new object into a 1,000-object scope touches exactly one row across every family table",
    scope: "delta-write-large-scope",
    seedCount: 1000,
    seedBatchSize: 100,
    timeoutMs: 30_000,
  },
  {
    description:
      "writing one new object into a tiny 10-object scope also touches exactly one row, making the flatness explicit",
    scope: "delta-write-tiny-scope",
    seedCount: 10,
    seedBatchSize: 10,
    timeoutMs: 10_000,
  },
];

describe("@tuvren/backend-postgres delta-proportional writes (KRT-BK012)", () => {
  for (const testCase of DELTA_WRITE_CASES) {
    test(
      testCase.description,
      async () => {
        const options = createPostgresTestBackendOptions({
          scope: testCase.scope,
        });
        const backend = createPostgresBackend(options);

        try {
          await seedObjects(
            backend,
            testCase.seedCount,
            testCase.seedBatchSize
          );

          const newRecord = await createStoredObjectRecord(
            objectBytesForIndex(testCase.seedCount),
            2
          );

          await backend.transact(async (tx) => {
            await tx.objects.put(newRecord);
          });

          const admin = createAdminClient(options);
          try {
            const transactionId = await readObjectRowTransactionId(
              admin,
              requireSchemaName(options),
              testCase.scope,
              newRecord.hash
            );
            const countsByTable = await countRowsWrittenByTransaction(
              admin,
              requireSchemaName(options),
              testCase.scope,
              transactionId
            );

            expect(totalRows(countsByTable)).toBe(1);
            expect(countsByTable.objects).toBe(1);
          } finally {
            await admin.end({ timeout: 0 });
          }
        } finally {
          await backend.destroy();
        }
      },
      testCase.timeoutMs
    );
  }
});
