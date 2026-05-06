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

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";

export const NESTED_TRANSACTION_ERROR_PATTERN = /must not be nested/u;
export const MIGRATION_CONFLICT_ERROR_PATTERN =
  /table turn_trees already exists/u;
export const MISSING_SCHEMA_ERROR_PATTERN =
  /applied migration without its required schema tables/u;
export const MISSING_INDEX_ERROR_PATTERN =
  /applied migration without its required schema indexes/u;
export const NON_PERSISTENT_DATABASE_ERROR_PATTERN =
  /requires a filesystem database path|non-empty filesystem database path/u;
export const NORMALIZED_ENGINE_ERROR_PATTERN =
  /sqlite backend engine operation failed/u;
export const NORMALIZED_STARTUP_ERROR_PATTERN =
  /sqlite backend engine operation failed|sqlite backend operation failed/u;
export const NORMALIZED_SQLITE_ERROR_PATTERN =
  /required schema tables|missing schema tables/u;
export const SCHEMA_MISMATCH_ERROR_PATTERN =
  /column contract does not match|foreign-key contract does not match/u;
export const INDEX_MISMATCH_ERROR_PATTERN =
  /index whose definition does not match/u;
export const UNKNOWN_MIGRATION_ERROR_PATTERN = /does not recognize/u;
export const MULTIPLE_ACTIVE_RUNS_ERROR_PATTERN = /more than one active run/u;
export const BACKWARD_ARCHIVE_ERROR_PATTERN = /archive branch/u;
export const RUN_STATUS_ERROR_PATTERN = /valid run status/u;
export const RUN_SHAPE_ERROR_PATTERN = /currentStepIndex/u;
export const RUN_STAGED_RESULT_ERROR_PATTERN =
  /staged results may only exist for running runs|terminal or paused runs must not retain staged results/u;
export const RUN_TURN_SPAN_ERROR_PATTERN = /referenced turn head|turn span/u;
export const STAGED_RESULT_ROW_ERROR_PATTERN =
  /valid staged result status|interrupt_payload_cbor/u;
export const TURN_TREE_PATH_ROW_ERROR_PATTERN =
  /valid ordered or single variant/u;
export const LINEAGE_METADATA_ERROR_PATTERN = /lineage metadata/u;
export const ORDERED_CARDINALITY_ERROR_PATTERN =
  /orderedCount aligned|item_count aligned|decoded item count/u;
export const OBJECT_ROW_ERROR_PATTERN = /byteLength|SHA-256 digest/u;
export const TURN_PARENT_ERROR_PATTERN = /chain contiguously/u;
export const TURN_NODE_ROW_ERROR_PATTERN = /consumedStagedResultsCbor/u;
export const THREAD_ROW_ERROR_PATTERN = /createdAtMs|epoch millisecond value/u;
export const BRANCH_ROW_ERROR_PATTERN = /updatedAtMs/u;
export const TURN_ROW_ERROR_PATTERN = /updatedAtMs/u;

const tempDirectories = new Set<string>();

export function createTempDirectory(prefix = "kraken-sqlite-"): string {
  const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(tempDirectory);
  return tempDirectory;
}

export function createTempDatabasePath(): string {
  const tempDirectory = createTempDirectory();
  return join(tempDirectory, "kraken.db");
}

export function createWorkspaceTempDirectory(prefix: string): string {
  const tempDirectory = mkdtempSync(join(process.cwd(), prefix));
  tempDirectories.add(tempDirectory);
  return tempDirectory;
}

export function linkWorkspaceNodeModules(targetDirectory: string): void {
  symlinkSync(
    resolve(process.cwd(), "../../../../../node_modules"),
    join(targetDirectory, "node_modules"),
    "dir"
  );
}

export interface CorruptionSeed {
  databasePath: string;
  objectHash: string;
  rootTurnNodeHash: string;
  runId: string;
  runStartTurnNodeHash: string;
  turnTreeHash: string;
}

export interface LineageMembershipCorruptionSeed extends CorruptionSeed {
  foreignBranchId: string;
  foreignThreadId: string;
}

interface ExplainQueryPlanRow {
  detail: string;
}

function getCompiledSqliteRuntimePath(): string {
  return join(
    process.cwd(),
    ".tmp-tests",
    "boundaries",
    "kernel",
    "implementations",
    "typescript",
    "backend-sqlite",
    "src",
    "lib",
    "sqlite-backend.js"
  );
}

export function copyCompiledSqliteRuntimeBundle(
  targetRuntimePath: string
): void {
  const compiledRuntimePath = getCompiledSqliteRuntimePath();
  const compiledRuntimeDirectory = dirname(compiledRuntimePath);
  const targetRuntimeDirectory = dirname(targetRuntimePath);

  copyFileSync(compiledRuntimePath, targetRuntimePath);
  for (const fileName of [
    "sqlite-schema.js",
    "sqlite-errors.js",
    "sqlite-records.js",
    "sqlite-lookups.js",
    "sqlite-write-tracker.js",
    "sqlite-repositories-support.js",
    "sqlite-repositories-core.js",
    "sqlite-state-utils.js",
    "sqlite-state-validation.js",
    "sqlite-run-invariants.js",
    "sqlite-db-lineage.js",
    "sqlite-integrity-assertions.js",
    "sqlite-transaction-validation.js",
    "sqlite-validation.js",
  ]) {
    copyFileSync(
      join(compiledRuntimeDirectory, fileName),
      join(targetRuntimeDirectory, fileName)
    );
  }
}

export function getBaselineMigrationSql(): string {
  return readFileSync(
    join(process.cwd(), "migrations", "0001_initial_schema.sql"),
    "utf8"
  );
}

export function getTargetedValidationMigrationSql(): string {
  return readFileSync(
    join(process.cwd(), "migrations", "0002_targeted_validation_indexes.sql"),
    "utf8"
  );
}

export function getPendingSignalsAndAnnotationsMigrationSql(): string {
  return readFileSync(
    join(
      process.cwd(),
      "migrations",
      "0003_pending_signals_and_annotations.sql"
    ),
    "utf8"
  );
}

export function copyCurrentPackageMigrations(targetDirectory: string): void {
  const migrationsDirectory = join(process.cwd(), "migrations");
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of migrationFiles) {
    copyFileSync(
      join(migrationsDirectory, fileName),
      join(targetDirectory, fileName)
    );
  }
}

function explainQueryPlanDetails(
  db: Database.Database,
  sql: string,
  parameters: readonly unknown[] = []
): string[] {
  return (
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters) as ExplainQueryPlanRow[]
  ).map((row) => row.detail);
}

export function assertPlanUsesIndex(
  db: Database.Database,
  sql: string,
  indexName: string,
  parameters: readonly unknown[] = []
): void {
  const details = explainQueryPlanDetails(db, sql, parameters);
  strictEqual(
    details.some((detail) => detail.includes(indexName)),
    true,
    details.join("\n")
  );
}

export async function seedCorruptionDatabase(
  options: { messageCount?: number } = {}
): Promise<CorruptionSeed> {
  const databasePath = createTempDatabasePath();
  const backend = createSqliteBackend({ databasePath });
  const messageCount = options.messageCount ?? 0;
  const messages = Array.from({ length: messageCount }, (_, index) =>
    createHashFromIndex(index + 1)
  );
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    { "context.manifest": null, messages },
    2
  );
  const objectRecord = await createStoredObjectRecord(new Uint8Array([7]), 3);
  const rootTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 4,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const headTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 5,
    eventHash: null,
    previousTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread = {
    createdAtMs: 6,
    rootTurnNodeHash: rootTurnNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_corruption",
  };
  const branch = {
    branchId: "branch_corruption",
    createdAtMs: 7,
    headTurnNodeHash: headTurnNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 7,
  };
  const turn = {
    branchId: branch.branchId,
    createdAtMs: 8,
    headTurnNodeHash: headTurnNode.hash,
    parentTurnId: null,
    startTurnNodeHash: rootTurnNode.hash,
    threadId: thread.threadId,
    turnId: "turn_corruption",
    updatedAtMs: 8,
  };
  const run = {
    branchId: branch.branchId,
    createdAtMs: 9,
    createdTurnNodesCbor: encodeDeterministicKernelRecord([]),
    currentStepIndex: 0,
    runId: "run_corruption",
    schemaId: schema.schemaId,
    startTurnNodeHash: headTurnNode.hash,
    status: "running" as const,
    stepSequenceCbor: encodeDeterministicKernelRecord([
      {
        deterministic: false,
        id: "model_call",
        sideEffects: false,
      },
    ]),
    turnId: turn.turnId,
    updatedAtMs: 9,
  };

  await backend.transact(async (tx) => {
    await tx.objects.put(objectRecord);
    await tx.schemas.put(schemaRecord);
    await tx.turnTrees.put(turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(turnTree, {
        "context.manifest": null,
        messages,
      })
    );
    await tx.turnNodes.put(rootTurnNode);
    await tx.turnNodes.put(headTurnNode);
    await tx.threads.put(thread);
    await tx.branches.set(branch);
    await tx.turns.set(turn);
    await tx.runs.set(run);
  });

  return {
    databasePath,
    objectHash: objectRecord.hash,
    rootTurnNodeHash: rootTurnNode.hash,
    runId: run.runId,
    runStartTurnNodeHash: run.startTurnNodeHash,
    turnTreeHash: turnTree.hash,
  };
}

export async function seedLineageMembershipCorruptionDatabase(): Promise<LineageMembershipCorruptionSeed> {
  const seeded = await seedCorruptionDatabase();
  const backend = createSqliteBackend({ databasePath: seeded.databasePath });
  const schema = createCanonicalKernelTestSchema();
  const foreignTurnTree = await createStoredTurnTreeRecord(
    schema,
    {
      "context.manifest": null,
      messages: [createHashFromIndex(999)],
    },
    12
  );
  const foreignRootTurnNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 13,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: "schema_main",
    turnTreeHash: foreignTurnTree.hash,
  });
  const foreignThreadId = "thread_lineage_membership";
  const foreignBranchId = "branch_lineage_membership";

  await backend.transact(async (tx) => {
    await tx.turnTrees.put(foreignTurnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(foreignTurnTree, {
        "context.manifest": null,
        messages: [createHashFromIndex(999)],
      })
    );
    await tx.turnNodes.put(foreignRootTurnNode);
    await tx.threads.put({
      createdAtMs: 14,
      rootTurnNodeHash: foreignRootTurnNode.hash,
      schemaId: "schema_main",
      threadId: foreignThreadId,
    });
    await tx.branches.set({
      branchId: foreignBranchId,
      createdAtMs: 15,
      headTurnNodeHash: foreignRootTurnNode.hash,
      threadId: foreignThreadId,
      updatedAtMs: 15,
    });
    await tx.turns.set({
      branchId: foreignBranchId,
      createdAtMs: 16,
      headTurnNodeHash: foreignRootTurnNode.hash,
      parentTurnId: null,
      startTurnNodeHash: foreignRootTurnNode.hash,
      threadId: foreignThreadId,
      turnId: "turn_lineage_membership",
      updatedAtMs: 16,
    });
  });

  const probe = new Database(seeded.databasePath);
  probe
    .prepare(
      `
        UPDATE turn_node_lineage_roots
        SET root_turn_node_hash = ?
        WHERE turn_node_hash = ?
      `
    )
    .run(foreignRootTurnNode.hash, seeded.runStartTurnNodeHash);
  probe.close();

  return {
    ...seeded,
    foreignBranchId,
    foreignThreadId,
  };
}

export async function expectCorruptedStateRejection(
  databasePath: string,
  pattern: RegExp
): Promise<void> {
  const backend = createSqliteBackend({ databasePath });
  const health = await backend.health();
  deepStrictEqual(health.ok, false);
  if (health.ok) {
    throw new Error("expected unhealthy status");
  }
  strictEqual(pattern.test(health.reason), true);
}

after(() => {
  for (const tempDirectory of tempDirectories) {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
});
