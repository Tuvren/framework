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

import {
  deepStrictEqual,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import { describe, test } from "node:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import {
  encodeDeterministicKernelRecord,
  type RuntimeBackendTx as KrakenBackendTx,
} from "@tuvren/kernel-protocol";
import {
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredTurnNodeRecord,
  delay,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";
import {
  assertPlanUsesIndex,
  BACKWARD_ARCHIVE_ERROR_PATTERN,
  createTempDatabasePath,
  LINEAGE_METADATA_ERROR_PATTERN,
  MISSING_INDEX_ERROR_PATTERN,
  MISSING_SCHEMA_ERROR_PATTERN,
  MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN,
  NESTED_TRANSACTION_ERROR_PATTERN,
  NORMALIZED_ENGINE_ERROR_PATTERN,
  NORMALIZED_SQLITE_ERROR_PATTERN,
  OBJECT_ROW_ERROR_PATTERN,
  RUN_STAGED_RESULT_ERROR_PATTERN,
  RUN_TURN_SPAN_ERROR_PATTERN,
  seedCorruptionDatabase,
  seedLineageMembershipCorruptionDatabase,
  TURN_PARENT_ERROR_PATTERN,
} from "./backend-sqlite-test-helpers.js";

describe("@tuvren/backend-sqlite invariants", () => {
  test("reports unhealthy status when committed-state invariants are broken", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          INSERT INTO runs (
            run_id,
            turn_id,
            branch_id,
            schema_id,
            start_turn_node_hash,
            status,
            current_step_index,
            step_sequence_cbor,
            created_turn_nodes_cbor,
            created_at_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "run_duplicate_active",
        "turn_corruption",
        "branch_corruption",
        "schema_main",
        seeded.runStartTurnNodeHash,
        "running",
        0,
        Buffer.from(
          encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ])
        ),
        Buffer.from(encodeDeterministicKernelRecord([])),
        10,
        10
      );
    probe.close();

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN.test(health.reason), true);
  });

  test("keeps invariant-broken persisted state out of the transaction hot path", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          INSERT INTO runs (
            run_id,
            turn_id,
            branch_id,
            schema_id,
            start_turn_node_hash,
            status,
            current_step_index,
            step_sequence_cbor,
            created_turn_nodes_cbor,
            created_at_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "run_duplicate_preflight",
        "turn_corruption",
        "branch_corruption",
        "schema_main",
        seeded.runStartTurnNodeHash,
        "running",
        0,
        Buffer.from(
          encodeDeterministicKernelRecord([
            {
              deterministic: false,
              id: "model_call",
              sideEffects: false,
            },
          ])
        ),
        Buffer.from(encodeDeterministicKernelRecord([])),
        10,
        10
      );
    probe.close();

    let callbackRan = false;
    await backend.transact(() => {
      callbackRan = true;
      return Promise.resolve(undefined);
    });
    strictEqual(callbackRan, true);
  });

  test("rejects run status updates that leave staged results attached", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await backend.transact(async (tx) => {
      await tx.stagedResults.set({
        createdAtMs: 10,
        objectHash: seeded.objectHash,
        objectType: "message",
        runId: seeded.runId,
        status: "completed",
        taskId: "staged_before_pause",
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        const run = await tx.runs.get(seeded.runId);

        if (run === null) {
          throw new Error("expected seeded run");
        }

        await tx.runs.set({
          ...run,
          status: "failed",
          updatedAtMs: 11,
        });
      }),
      RUN_STAGED_RESULT_ERROR_PATTERN
    );
  });

  test("rejects turn head rewrites that break child turn parent links", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const childTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 12,
      eventHash: null,
      previousTurnNodeHash: seeded.runStartTurnNodeHash,
      schemaId: "schema_main",
      turnTreeHash: seeded.turnTreeHash,
    });

    await backend.transact(async (tx) => {
      const run = await tx.runs.get(seeded.runId);

      if (run === null) {
        throw new Error("expected seeded run");
      }

      await tx.runs.set({
        ...run,
        status: "failed",
        updatedAtMs: 10,
      });
      await tx.turnNodes.put(childTurnNode);
      await tx.turns.set({
        branchId: "branch_corruption",
        createdAtMs: 12,
        headTurnNodeHash: childTurnNode.hash,
        parentTurnId: "turn_corruption",
        startTurnNodeHash: seeded.runStartTurnNodeHash,
        threadId: "thread_corruption",
        turnId: "turn_child_corruption",
        updatedAtMs: 12,
      });
      await tx.branches.set({
        branchId: "branch_corruption",
        createdAtMs: 7,
        headTurnNodeHash: childTurnNode.hash,
        threadId: "thread_corruption",
        updatedAtMs: 12,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        const parentTurn = await tx.turns.get("turn_corruption");

        if (parentTurn === null) {
          throw new Error("expected parent turn");
        }

        await tx.turns.set({
          ...parentTurn,
          headTurnNodeHash: seeded.rootTurnNodeHash,
          updatedAtMs: 13,
        });
      }),
      TURN_PARENT_ERROR_PATTERN
    );
  });

  test("rejects turn head rewrites that break terminal run spans", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await backend.transact(async (tx) => {
      const run = await tx.runs.get(seeded.runId);
      if (run === null) {
        throw new Error("expected seeded run");
      }
      await tx.runs.set({
        ...run,
        status: "failed",
        updatedAtMs: 10,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        const turn = await tx.turns.get("turn_corruption");
        if (turn === null) {
          throw new Error("expected seeded turn");
        }
        await tx.turns.set({
          ...turn,
          headTurnNodeHash: seeded.rootTurnNodeHash,
          updatedAtMs: 11,
        });
      }),
      RUN_TURN_SPAN_ERROR_PATTERN
    );
  });

  test("requires a new archive branch for every rollback transaction", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await backend.transact(async (tx) => {
      const run = await tx.runs.get(seeded.runId);
      if (run === null) {
        throw new Error("expected seeded run");
      }
      await tx.runs.set({
        ...run,
        status: "failed",
        updatedAtMs: 10,
      });
      await tx.branches.set({
        archivedFromBranchId: "branch_corruption",
        branchId: "branch_corruption_archive_1",
        createdAtMs: 10,
        headTurnNodeHash: seeded.runStartTurnNodeHash,
        threadId: "thread_corruption",
        updatedAtMs: 10,
      });
      await tx.branches.set({
        branchId: "branch_corruption",
        createdAtMs: 7,
        headTurnNodeHash: seeded.rootTurnNodeHash,
        threadId: "thread_corruption",
        updatedAtMs: 10,
      });
    });

    await backend.transact(async (tx) => {
      await tx.branches.set({
        branchId: "branch_corruption",
        createdAtMs: 7,
        headTurnNodeHash: seeded.runStartTurnNodeHash,
        threadId: "thread_corruption",
        updatedAtMs: 11,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          branchId: "branch_corruption",
          createdAtMs: 7,
          headTurnNodeHash: seeded.rootTurnNodeHash,
          threadId: "thread_corruption",
          updatedAtMs: 12,
        });
      }),
      BACKWARD_ARCHIVE_ERROR_PATTERN
    );
  });

  test("keeps missing-run staged result clears idempotent", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });

    await backend.transact(async (tx) => {
      await tx.stagedResults.clearRun("missing_run");
    });
  });

  test("rejects appending turn nodes from stale lineage metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const childTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 12,
      eventHash: null,
      previousTurnNodeHash: seeded.runStartTurnNodeHash,
      schemaId: "schema_main",
      turnTreeHash: seeded.turnTreeHash,
    });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_node_lineage_roots
          SET root_turn_node_hash = turn_node_hash,
              depth = 0
          WHERE turn_node_hash = ?
        `
      )
      .run(seeded.runStartTurnNodeHash);
    probe.close();

    await rejects(
      backend.transact(async (tx) => {
        await tx.turnNodes.put(childTurnNode);
      }),
      LINEAGE_METADATA_ERROR_PATTERN
    );
  });

  test("rejects existing-node thread membership checks backed by stale lineage metadata", async () => {
    const seeded = await seedLineageMembershipCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          branchId: "branch_stale_lineage_membership",
          createdAtMs: 20,
          headTurnNodeHash: seeded.runStartTurnNodeHash,
          threadId: seeded.foreignThreadId,
          updatedAtMs: 20,
        });
      }),
      LINEAGE_METADATA_ERROR_PATTERN
    );
  });

  test("reports unhealthy status when required schema tables are missing", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec("DROP TABLE objects");
    probe.close();

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MISSING_SCHEMA_ERROR_PATTERN.test(health.reason), true);
  });

  test("leaves committed corruption detection on the explicit health path", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET hash = ? WHERE hash = ?")
      .run(createHashFromIndex(999), seeded.objectHash);
    probe.close();

    let callbackRan = false;
    await backend.transact(() => {
      callbackRan = true;
      return Promise.resolve(undefined);
    });
    strictEqual(callbackRan, true);

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(OBJECT_ROW_ERROR_PATTERN.test(health.reason), true);
  });

  test("reports missing tables through health instead of transaction preflight", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec("DROP TABLE objects");
    probe.close();

    await backend.transact(async () => undefined);

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(NORMALIZED_SQLITE_ERROR_PATTERN.test(health.reason), true);
  });

  test("normalizes SQLite engine write failures into backend persistence errors", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });
    const probe = new Database(databasePath);
    probe.exec(`
      CREATE TRIGGER objects_block_insert
      BEFORE INSERT ON objects
      BEGIN
        SELECT RAISE(FAIL, 'blocked');
      END;
    `);
    probe.close();
    const objectRecord = await createStoredObjectRecord(new Uint8Array([9]), 1);

    await rejects(
      backend.transact(async (tx) => {
        await tx.objects.put(objectRecord);
      }),
      NORMALIZED_ENGINE_ERROR_PATTERN
    );
  });

  test("rejects databases that are missing baseline indexes", async () => {
    const seeded = await seedCorruptionDatabase();
    const backend = createSqliteBackend({ databasePath: seeded.databasePath });
    const probe = new Database(seeded.databasePath);
    probe.exec("DROP INDEX idx_runs_branch_id_status");
    probe.close();

    throws(
      () => createSqliteBackend({ databasePath: seeded.databasePath }),
      MISSING_INDEX_ERROR_PATTERN
    );

    const health = await backend.health();
    deepStrictEqual(health.ok, false);
    if (health.ok) {
      throw new Error("expected unhealthy status");
    }
    strictEqual(MISSING_INDEX_ERROR_PATTERN.test(health.reason), true);
  });

  test("uses targeted indexes for localized validation query plans", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath, { readonly: true });

    try {
      assertPlanUsesIndex(
        probe,
        `
          SELECT turn_node_hash
          FROM turn_node_lineage_roots
          WHERE root_turn_node_hash = ? AND depth >= ?
        `,
        "idx_turn_node_lineage_roots_root_depth",
        [seeded.runStartTurnNodeHash, 0]
      );
    } finally {
      probe.close();
    }
  });

  test("serializes concurrent transactions and rejects nested transactions", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });
    const order: string[] = [];

    const firstTransaction = backend.transact(async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
    });
    const secondTransaction = backend.transact(() => {
      order.push("second:start");
      order.push("second:end");
      return Promise.resolve();
    });

    await Promise.all([firstTransaction, secondTransaction]);
    deepStrictEqual(order, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);

    await rejects(
      backend.transact(async () => {
        await backend.transact(async () => undefined);
      }),
      NESTED_TRANSACTION_ERROR_PATTERN
    );
  });

  test("rejects repository handle use after the transaction ends", async () => {
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
    });
    const escapedTransactions: KrakenBackendTx[] = [];

    await backend.transact((tx) => {
      escapedTransactions.push(tx);
      return Promise.resolve();
    });

    const txHandle = escapedTransactions[0];
    if (txHandle === undefined) {
      throw new Error("expected escaped transaction handle");
    }

    await rejects(
      async () => txHandle.objects.has("0".repeat(64)),
      TuvrenPersistenceError
    );
  });
});
