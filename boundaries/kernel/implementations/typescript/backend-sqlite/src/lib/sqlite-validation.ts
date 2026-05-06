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

import type Database from "better-sqlite3";
import {
  type ExpectedSqliteColumnSchema,
  type ExpectedSqliteForeignKeySchema,
  type ExpectedSqliteIndexSchema,
  type ExpectedSqliteTableSchema,
  INITIAL_SCHEMA_INDEX_DEFINITIONS,
  INITIAL_SCHEMA_MIGRATION_NAME,
  INITIAL_SCHEMA_REQUIRED_INDEXES,
  INITIAL_SCHEMA_REQUIRED_TABLES,
  INITIAL_SCHEMA_TABLE_DEFINITIONS,
  listMigrationFiles,
  OBSERVE_ANNOTATIONS_INDEX_DEFINITIONS,
  OBSERVE_ANNOTATIONS_MIGRATION_NAME,
  OBSERVE_ANNOTATIONS_REQUIRED_TABLES,
  OBSERVE_ANNOTATIONS_TABLE_DEFINITIONS,
  PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME,
  PRE_PENDING_RUN_COLUMN_NAMES,
  PRE_PENDING_SIGNALS_SCHEMA_TABLE_DEFINITIONS,
  PRE_RUN_LIVENESS_SCHEMA_TABLE_DEFINITIONS,
  RUN_LIVENESS_INDEX_DEFINITIONS,
  RUN_LIVENESS_MIGRATION_NAME,
  RUN_LIVENESS_REQUIRED_INDEXES,
  RUN_LIVENESS_RUN_COLUMN_NAMES,
  resolveMigrationDirectory,
  type SqlitePersistenceErrorFactory,
  TARGETED_VALIDATION_INDEX_DEFINITIONS,
  TARGETED_VALIDATION_MIGRATION_NAME,
  TARGETED_VALIDATION_REQUIRED_INDEXES,
  TARGETED_VALIDATION_REQUIRED_TABLES,
  TARGETED_VALIDATION_TABLE_DEFINITIONS,
} from "./sqlite-schema.js";

interface SqliteMigrationRow {
  name: string;
}

interface SqliteForeignKeyPragmaRow {
  from: string;
  id: number;
  match: string;
  on_delete: string;
  on_update: string;
  seq: number;
  table: string;
  to: string;
}

interface SqliteIndexInfoPragmaRow {
  cid: number;
  name: string;
  seqno: number;
}

interface SqliteIndexListPragmaRow {
  name: string;
  origin: string;
  partial: number;
  seq: number;
  unique: number;
}

interface SqliteTableInfoPragmaRow {
  cid: number;
  dflt_value: unknown;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

export function loadAppliedMigrationNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM backend_sqlite_migrations ORDER BY name")
      .all() as SqliteMigrationRow[]
  ).map((row) => row.name);
}

export function validateMigrationState(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const knownMigrationFiles = listMigrationFiles(
    resolveMigrationDirectory(persistenceError)
  );
  const appliedMigrationNames = loadAppliedMigrationNames(db);
  const appliedMigrations = new Set(appliedMigrationNames);
  const unknownAppliedMigrations = [...appliedMigrations].filter(
    (migrationName) => !knownMigrationFiles.includes(migrationName)
  );

  if (unknownAppliedMigrations.length > 0) {
    throw persistenceError(
      "sqlite backend found applied migrations that this package version does not recognize",
      "sqlite_backend_unknown_applied_migration",
      {
        knownMigrationFiles,
        unknownAppliedMigrations,
      }
    );
  }

  if (!appliedMigrations.has(INITIAL_SCHEMA_MIGRATION_NAME)) {
    return;
  }

  validateBaselineSchemaPresence(db, persistenceError);

  if (appliedMigrations.has(TARGETED_VALIDATION_MIGRATION_NAME)) {
    validateTargetedValidationSchemaPresence(db, persistenceError);
  }

  if (appliedMigrations.has(PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME)) {
    validatePendingSignalsAndAnnotationsSchemaPresence(db, persistenceError);
  }

  if (appliedMigrations.has(OBSERVE_ANNOTATIONS_MIGRATION_NAME)) {
    validateObserveAnnotationsSchemaPresence(db, persistenceError);
  }

  if (appliedMigrations.has(RUN_LIVENESS_MIGRATION_NAME)) {
    validateRunLivenessSchemaPresence(db, persistenceError);
  }

  const latestAppliedMigrationName = appliedMigrationNames.at(-1);
  if (latestAppliedMigrationName === INITIAL_SCHEMA_MIGRATION_NAME) {
    validatePrePendingSignalsSchemaShape(db, persistenceError);
    return;
  }

  if (latestAppliedMigrationName === TARGETED_VALIDATION_MIGRATION_NAME) {
    validatePrePendingSignalsSchemaShape(db, persistenceError);
    validateTargetedValidationSchemaShape(db, persistenceError);
    return;
  }

  if (
    latestAppliedMigrationName ===
    PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME
  ) {
    validatePendingSignalsAndAnnotationsSchemaShape(db, persistenceError);
    return;
  }

  if (latestAppliedMigrationName === OBSERVE_ANNOTATIONS_MIGRATION_NAME) {
    validatePreRunLivenessSchemaShape(db, persistenceError);
    return;
  }

  if (latestAppliedMigrationName === RUN_LIVENESS_MIGRATION_NAME) {
    validateCurrentPackageSchemaShape(db, persistenceError);
  }
}

function validateBaselineSchemaPresence(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const existingTables = loadSqliteMasterNames(db, "table");
  const missingTables = INITIAL_SCHEMA_REQUIRED_TABLES.filter(
    (tableName) => !existingTables.has(tableName)
  );

  if (missingTables.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its required schema tables",
      "sqlite_backend_applied_migration_schema_missing",
      {
        migrationName: INITIAL_SCHEMA_MIGRATION_NAME,
        missingTables,
      }
    );
  }

  const existingIndexes = loadSqliteMasterNames(db, "index");
  const missingIndexes = INITIAL_SCHEMA_REQUIRED_INDEXES.filter(
    (indexName) => !existingIndexes.has(indexName)
  );

  if (missingIndexes.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its required schema indexes",
      "sqlite_backend_applied_migration_index_missing",
      {
        migrationName: INITIAL_SCHEMA_MIGRATION_NAME,
        missingIndexes,
      }
    );
  }
}

function validateTargetedValidationSchemaPresence(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const existingTables = loadSqliteMasterNames(db, "table");
  const missingTables = TARGETED_VALIDATION_REQUIRED_TABLES.filter(
    (tableName) => !existingTables.has(tableName)
  );

  if (missingTables.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its targeted validation tables",
      "sqlite_backend_applied_migration_schema_missing",
      {
        migrationName: TARGETED_VALIDATION_MIGRATION_NAME,
        missingTables,
      }
    );
  }

  const existingIndexes = loadSqliteMasterNames(db, "index");
  const missingIndexes = TARGETED_VALIDATION_REQUIRED_INDEXES.filter(
    (indexName) => !existingIndexes.has(indexName)
  );

  if (missingIndexes.length > 0) {
    throw persistenceError(
      "sqlite backend found an applied migration without its targeted validation indexes",
      "sqlite_backend_applied_migration_index_missing",
      {
        migrationName: TARGETED_VALIDATION_MIGRATION_NAME,
        missingIndexes,
      }
    );
  }
}

function validatePendingSignalsAndAnnotationsSchemaPresence(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const tableInfo = db
    .prepare("PRAGMA table_info(runs)")
    .all() as SqliteTableInfoPragmaRow[];
  const columns = new Map(tableInfo.map((column) => [column.name, column]));

  for (const columnName of PRE_PENDING_RUN_COLUMN_NAMES) {
    const column = columns.get(columnName);

    if (column === undefined) {
      throw persistenceError(
        "sqlite backend found an applied migration without its pending signal schema columns",
        "sqlite_backend_applied_migration_schema_missing",
        {
          columnName,
          migrationName: PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME,
          tableName: "runs",
        }
      );
    }

    if (column.type.toUpperCase() !== "BLOB" || column.notnull !== 0) {
      throw persistenceError(
        "sqlite backend found an applied migration column whose pending signal contract does not match the package schema",
        "sqlite_backend_applied_migration_schema_mismatch",
        {
          actualColumn: {
            name: column.name,
            notNull: column.notnull === 1,
            type: column.type.toUpperCase(),
          },
          expectedColumn: {
            name: columnName,
            notNull: false,
            type: "BLOB",
          },
          migrationName: PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME,
          tableName: "runs",
        }
      );
    }
  }
}

function validatePrePendingSignalsSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validateSqliteSchemaShape(
    db,
    INITIAL_SCHEMA_MIGRATION_NAME,
    PRE_PENDING_SIGNALS_SCHEMA_TABLE_DEFINITIONS,
    INITIAL_SCHEMA_INDEX_DEFINITIONS,
    persistenceError
  );
}

function validateCurrentPackageSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validateRunLivenessSchemaShape(db, persistenceError);
}

function validatePendingSignalsAndAnnotationsSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validateSqliteSchemaShape(
    db,
    PENDING_SIGNALS_AND_ANNOTATIONS_MIGRATION_NAME,
    PRE_RUN_LIVENESS_SCHEMA_TABLE_DEFINITIONS,
    INITIAL_SCHEMA_INDEX_DEFINITIONS,
    persistenceError
  );
  validateTargetedValidationSchemaShape(db, persistenceError);
}

function validateTargetedValidationSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validateSqliteSchemaShape(
    db,
    TARGETED_VALIDATION_MIGRATION_NAME,
    TARGETED_VALIDATION_TABLE_DEFINITIONS,
    TARGETED_VALIDATION_INDEX_DEFINITIONS,
    persistenceError
  );
}

function validateObserveAnnotationsSchemaPresence(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const existingTables = loadSqliteMasterNames(db, "table");

  for (const tableName of OBSERVE_ANNOTATIONS_REQUIRED_TABLES) {
    if (existingTables.has(tableName)) {
      continue;
    }

    throw persistenceError(
      "sqlite backend found an applied migration without its observe annotation schema table",
      "sqlite_backend_applied_migration_schema_missing",
      {
        migrationName: OBSERVE_ANNOTATIONS_MIGRATION_NAME,
        tableName,
      }
    );
  }
}

function _validateObserveAnnotationsSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validatePreRunLivenessSchemaShape(db, persistenceError);
}

function validatePreRunLivenessSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validateSqliteSchemaShape(
    db,
    OBSERVE_ANNOTATIONS_MIGRATION_NAME,
    {
      ...PRE_RUN_LIVENESS_SCHEMA_TABLE_DEFINITIONS,
      ...OBSERVE_ANNOTATIONS_TABLE_DEFINITIONS,
    },
    {
      ...INITIAL_SCHEMA_INDEX_DEFINITIONS,
      ...TARGETED_VALIDATION_INDEX_DEFINITIONS,
      ...OBSERVE_ANNOTATIONS_INDEX_DEFINITIONS,
    },
    persistenceError
  );
}

function validateRunLivenessSchemaPresence(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const tableInfo = db
    .prepare("PRAGMA table_info(runs)")
    .all() as SqliteTableInfoPragmaRow[];
  const columns = new Map(tableInfo.map((column) => [column.name, column]));

  for (const columnName of RUN_LIVENESS_RUN_COLUMN_NAMES) {
    const column = columns.get(columnName);

    if (column === undefined) {
      throw persistenceError(
        "sqlite backend found an applied migration without its run liveness schema columns",
        "sqlite_backend_applied_migration_schema_missing",
        {
          columnName,
          migrationName: RUN_LIVENESS_MIGRATION_NAME,
          tableName: "runs",
        }
      );
    }
  }

  for (const indexName of RUN_LIVENESS_REQUIRED_INDEXES) {
    if (loadSqliteMasterNames(db, "index").has(indexName)) {
      continue;
    }

    throw persistenceError(
      "sqlite backend found an applied migration without its run liveness schema index",
      "sqlite_backend_applied_migration_schema_missing",
      {
        indexName,
        migrationName: RUN_LIVENESS_MIGRATION_NAME,
      }
    );
  }
}

function validateRunLivenessSchemaShape(
  db: Database.Database,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  validateSqliteSchemaShape(
    db,
    RUN_LIVENESS_MIGRATION_NAME,
    {
      ...INITIAL_SCHEMA_TABLE_DEFINITIONS,
      ...TARGETED_VALIDATION_TABLE_DEFINITIONS,
      ...OBSERVE_ANNOTATIONS_TABLE_DEFINITIONS,
    },
    {
      ...INITIAL_SCHEMA_INDEX_DEFINITIONS,
      ...TARGETED_VALIDATION_INDEX_DEFINITIONS,
      ...OBSERVE_ANNOTATIONS_INDEX_DEFINITIONS,
      ...RUN_LIVENESS_INDEX_DEFINITIONS,
    },
    persistenceError
  );
}

function validateSqliteSchemaShape(
  db: Database.Database,
  migrationName: string,
  tableDefinitions: Readonly<Record<string, ExpectedSqliteTableSchema>>,
  indexDefinitions: Readonly<Record<string, ExpectedSqliteIndexSchema>>,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  for (const [tableName, tableSchema] of Object.entries(tableDefinitions)) {
    validateSqliteTableSchema(
      db,
      migrationName,
      tableName,
      tableSchema,
      persistenceError
    );
  }

  for (const [indexName, indexSchema] of Object.entries(indexDefinitions)) {
    validateSqliteIndexSchema(
      db,
      migrationName,
      indexName,
      indexSchema,
      persistenceError
    );
  }
}

function loadSqliteMasterNames(
  db: Database.Database,
  type: "index" | "table"
): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  );
}

function validateSqliteTableSchema(
  db: Database.Database,
  migrationName: string,
  tableName: string,
  expectedSchema: ExpectedSqliteTableSchema,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const tableInfo = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as SqliteTableInfoPragmaRow[];
  const actualColumns = tableInfo.map((column) => ({
    name: column.name,
    notNull: column.notnull === 1,
    primaryKeyOrder: column.pk,
    type: column.type.toUpperCase(),
  }));
  const expectedColumns = expectedSchema.columns.map((column) => ({
    ...column,
    type: column.type.toUpperCase(),
  }));

  if (!areExpectedColumnsEqual(actualColumns, expectedColumns)) {
    throw persistenceError(
      "sqlite backend found an applied migration table whose column contract does not match the package schema",
      "sqlite_backend_applied_migration_schema_mismatch",
      {
        actualColumns,
        expectedColumns,
        migrationName,
        tableName,
      }
    );
  }

  const foreignKeyRows = db
    .prepare(`PRAGMA foreign_key_list(${tableName})`)
    .all() as SqliteForeignKeyPragmaRow[];
  const actualForeignKeys = groupForeignKeyRows(foreignKeyRows);
  if (
    !areExpectedForeignKeysEqual(actualForeignKeys, expectedSchema.foreignKeys)
  ) {
    throw persistenceError(
      "sqlite backend found an applied migration table whose foreign-key contract does not match the package schema",
      "sqlite_backend_applied_migration_schema_mismatch",
      {
        actualForeignKeys,
        expectedForeignKeys: expectedSchema.foreignKeys,
        migrationName,
        tableName,
      }
    );
  }
}

function validateSqliteIndexSchema(
  db: Database.Database,
  migrationName: string,
  indexName: string,
  expectedSchema: ExpectedSqliteIndexSchema,
  persistenceError: SqlitePersistenceErrorFactory
): void {
  const indexEntry = (
    db
      .prepare(`PRAGMA index_list(${expectedSchema.tableName})`)
      .all() as SqliteIndexListPragmaRow[]
  ).find((entry) => entry.name === indexName);

  if (indexEntry === undefined) {
    throw persistenceError(
      "sqlite backend found an applied migration without its required schema indexes",
      "sqlite_backend_applied_migration_index_missing",
      {
        indexName,
        migrationName,
      }
    );
  }

  const actualIndex = {
    columns: (
      db
        .prepare(`PRAGMA index_info(${indexName})`)
        .all() as SqliteIndexInfoPragmaRow[]
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name),
    partial: indexEntry.partial === 1,
    origin: indexEntry.origin,
    tableName: expectedSchema.tableName,
    unique: indexEntry.unique === 1,
  };
  const expectedIndex = {
    columns: [...expectedSchema.columns],
    partial: false,
    origin: "c",
    tableName: expectedSchema.tableName,
    unique: expectedSchema.unique,
  };

  if (!areExpectedIndexDefinitionsEqual(actualIndex, expectedIndex)) {
    throw persistenceError(
      "sqlite backend found an applied migration index whose definition does not match the package schema",
      "sqlite_backend_applied_migration_index_mismatch",
      {
        actualIndex,
        expectedIndex,
        indexName,
        migrationName,
      }
    );
  }
}

function groupForeignKeyRows(
  rows: readonly SqliteForeignKeyPragmaRow[]
): ExpectedSqliteForeignKeySchema[] {
  const groupedRows = new Map<number, SqliteForeignKeyPragmaRow[]>();

  for (const row of rows) {
    const group = groupedRows.get(row.id) ?? [];
    group.push(row);
    groupedRows.set(row.id, group);
  }

  return [...groupedRows.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, group]) => {
      const sortedGroup = [...group].sort(
        (left, right) => left.seq - right.seq
      );
      const [firstRow] = sortedGroup;
      if (firstRow === undefined) {
        throw new Error("expected at least one foreign key row");
      }

      return {
        columns: sortedGroup.map((row) => row.from),
        referencedColumns: sortedGroup.map((row) => row.to),
        referencedTable: firstRow.table,
      };
    });
}

function areExpectedColumnsEqual(
  left: readonly ExpectedSqliteColumnSchema[],
  right: readonly ExpectedSqliteColumnSchema[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (const [index, leftColumn] of left.entries()) {
    const rightColumn = right[index];
    if (
      rightColumn === undefined ||
      leftColumn.name !== rightColumn.name ||
      leftColumn.notNull !== rightColumn.notNull ||
      leftColumn.primaryKeyOrder !== rightColumn.primaryKeyOrder ||
      leftColumn.type !== rightColumn.type
    ) {
      return false;
    }
  }

  return true;
}

function areExpectedForeignKeysEqual(
  left: readonly ExpectedSqliteForeignKeySchema[],
  right: readonly ExpectedSqliteForeignKeySchema[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort(compareExpectedForeignKeys);
  const normalizedRight = [...right].sort(compareExpectedForeignKeys);

  for (const [index, leftForeignKey] of normalizedLeft.entries()) {
    const rightForeignKey = normalizedRight[index];
    if (
      rightForeignKey === undefined ||
      leftForeignKey.referencedTable !== rightForeignKey.referencedTable ||
      !areStringArraysEqual(leftForeignKey.columns, rightForeignKey.columns) ||
      !areStringArraysEqual(
        leftForeignKey.referencedColumns,
        rightForeignKey.referencedColumns
      )
    ) {
      return false;
    }
  }

  return true;
}

function compareExpectedForeignKeys(
  left: ExpectedSqliteForeignKeySchema,
  right: ExpectedSqliteForeignKeySchema
): number {
  return [
    left.referencedTable,
    left.columns.join("\u0000"),
    left.referencedColumns.join("\u0000"),
  ]
    .join("\u0001")
    .localeCompare(
      [
        right.referencedTable,
        right.columns.join("\u0000"),
        right.referencedColumns.join("\u0000"),
      ].join("\u0001")
    );
}

function areExpectedIndexDefinitionsEqual(
  left: {
    columns: readonly string[];
    origin: string;
    partial: boolean;
    tableName: string;
    unique: boolean;
  },
  right: {
    columns: readonly string[];
    origin: string;
    partial: boolean;
    tableName: string;
    unique: boolean;
  }
): boolean {
  return (
    left.origin === right.origin &&
    left.partial === right.partial &&
    left.tableName === right.tableName &&
    left.unique === right.unique &&
    areStringArraysEqual(left.columns, right.columns)
  );
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (const [index, leftValue] of left.entries()) {
    if (right[index] !== leftValue) {
      return false;
    }
  }

  return true;
}
