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

import { describe, test } from "node:test";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import { createHashFromIndex } from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import {
  BRANCH_ROW_ERROR_PATTERN,
  expectCorruptedStateRejection,
  LINEAGE_METADATA_ERROR_PATTERN,
  OBJECT_ROW_ERROR_PATTERN,
  ORDERED_CARDINALITY_ERROR_PATTERN,
  RUN_SHAPE_ERROR_PATTERN,
  RUN_STATUS_ERROR_PATTERN,
  STAGED_RESULT_ROW_ERROR_PATTERN,
  seedCorruptionDatabase,
  THREAD_ROW_ERROR_PATTERN,
  TURN_NODE_ROW_ERROR_PATTERN,
  TURN_ROW_ERROR_PATTERN,
  TURN_TREE_PATH_ROW_ERROR_PATTERN,
} from "./backend-sqlite-test-helpers.js";

describe("@tuvren/backend-sqlite record validation", () => {
  test("rejects stored run rows with invalid status values", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE runs SET status = 'bogus' WHERE run_id = ?")
      .run(seeded.runId);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      RUN_STATUS_ERROR_PATTERN
    );
  });

  test("rejects stored object rows with invalid byteLength metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET byte_length = 999 WHERE hash = ?")
      .run(seeded.objectHash);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      OBJECT_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored object rows whose hash no longer matches bytes", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE objects SET hash = ? WHERE hash = ?")
      .run(createHashFromIndex(999), seeded.objectHash);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      OBJECT_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored run rows with invalid currentStepIndex metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE runs SET current_step_index = -1 WHERE run_id = ?")
      .run(seeded.runId);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      RUN_SHAPE_ERROR_PATTERN
    );
  });

  test("rejects stored staged result rows with interrupted status and null payload", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          INSERT INTO staged_results (
            run_id,
            task_id,
            object_hash,
            object_type,
            status,
            interrupt_payload_cbor,
            created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        seeded.runId,
        "task_corrupted",
        seeded.objectHash,
        "message",
        "interrupted",
        null,
        10
      );
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      STAGED_RESULT_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored turn node rows with malformed consumed staged results payloads", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        "UPDATE turn_nodes SET consumed_staged_results_cbor = ? WHERE hash = ?"
      )
      .run(
        Buffer.from(
          encodeDeterministicKernelRecord([{ objectHash: seeded.objectHash }])
        ),
        seeded.runStartTurnNodeHash
      );
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      TURN_NODE_ROW_ERROR_PATTERN
    );
  });

  test("rejects corrupted turn node lineage metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_node_lineage_roots
          SET depth = depth + 1
          WHERE turn_node_hash = ?
        `
      )
      .run(seeded.runStartTurnNodeHash);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      LINEAGE_METADATA_ERROR_PATTERN
    );
  });

  test("rejects stored thread rows with invalid createdAtMs metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare("UPDATE threads SET created_at_ms = 1.5 WHERE thread_id = ?")
      .run("thread_corruption");
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      THREAD_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored branch rows with regressed updatedAtMs metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        "UPDATE branches SET updated_at_ms = created_at_ms - 1 WHERE branch_id = ?"
      )
      .run("branch_corruption");
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      BRANCH_ROW_ERROR_PATTERN
    );
  });

  test("rejects stored turn rows with regressed updatedAtMs metadata", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        "UPDATE turns SET updated_at_ms = created_at_ms - 1 WHERE turn_id = ?"
      )
      .run("turn_corruption");
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      TURN_ROW_ERROR_PATTERN
    );
  });

  test("rejects ordered turn tree rows with invalid collection kind", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_tree_paths
          SET collection_kind = 'bogus'
          WHERE turn_tree_hash = ? AND path = 'messages'
        `
      )
      .run(seeded.turnTreeHash);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      TURN_TREE_PATH_ROW_ERROR_PATTERN
    );
  });

  test("rejects corrupted orderedCount metadata on persisted path rows", async () => {
    const seeded = await seedCorruptionDatabase();
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE turn_tree_paths
          SET ordered_count = 999
          WHERE turn_tree_hash = ? AND path = 'messages'
        `
      )
      .run(seeded.turnTreeHash);
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      ORDERED_CARDINALITY_ERROR_PATTERN
    );
  });

  test("rejects corrupted chunk item_count metadata on persisted chunk rows", async () => {
    const seeded = await seedCorruptionDatabase({ messageCount: 40 });
    const probe = new Database(seeded.databasePath);
    probe
      .prepare(
        `
          UPDATE ordered_path_chunks
          SET item_count = item_count + 1
          WHERE chunk_hash = (
            SELECT chunk_hash
            FROM ordered_path_chunks
            ORDER BY chunk_hash
            LIMIT 1
          )
        `
      )
      .run();
    probe.close();
    await expectCorruptedStateRejection(
      seeded.databasePath,
      ORDERED_CARDINALITY_ERROR_PATTERN
    );
  });
});
