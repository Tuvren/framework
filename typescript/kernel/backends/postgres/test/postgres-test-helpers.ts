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

import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_SCOPE } from "@tuvren/core";
import postgres from "postgres";
import type { PostgresBackendOptions } from "../src/index.js";

const DEVENV_DATABASE_NAME = "tuvren_runtime";
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const allocatedSchemas = new Set<string>();

interface DevenvPostgresEnvironment {
  host: string;
  port: number;
  username: string;
}

export async function assertDevenvPostgresReady(): Promise<void> {
  // The session starts PostgreSQL through `devenv up -d`, but the daemon can
  // still report ready before the server accepts connections. On a cold shell
  // the socket file may not exist yet, surfacing as `ENOENT` on the first
  // probe. Retry the readiness query up to the budget below so the test does
  // not depend on an implicit timing assumption between service startup and
  // the test runner.
  const totalBudgetMs = 30_000;
  const retryDelayMs = 250;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < totalBudgetMs) {
    const sql = createSqlClient();

    try {
      const result = await sql<{ ready: number }[]>`SELECT 1 AS ready`;

      if (result[0]?.ready !== 1) {
        throw new Error("devenv postgres readiness query returned no row");
      }

      return;
    } catch (error: unknown) {
      lastError = error;
    } finally {
      await sql.end({ timeout: 0 });
    }

    await delay(retryDelayMs);
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `devenv postgres did not become ready within ${totalBudgetMs}ms: ${message}`
  );
}

export function createPostgresTestBackendOptions(
  overrides: Partial<PostgresBackendOptions> = {}
): PostgresBackendOptions {
  const environment = readDevenvPostgresEnvironment();
  const schemaName =
    overrides.schemaName ?? `test_${randomUUID().replaceAll("-", "_")}`;

  assertSchemaName(schemaName);
  allocatedSchemas.add(schemaName);

  return {
    database: DEVENV_DATABASE_NAME,
    host: environment.host,
    port: environment.port,
    schemaName,
    username: environment.username,
    ...overrides,
  };
}

export async function cleanupAllocatedSchemas(): Promise<void> {
  if (allocatedSchemas.size === 0) {
    return;
  }

  const sql = createSqlClient();

  try {
    for (const schemaName of allocatedSchemas) {
      assertSchemaName(schemaName);
      await sql.unsafe(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`
      );
    }
  } finally {
    allocatedSchemas.clear();
    await sql.end({ timeout: 0 });
  }
}

/**
 * Reads the raw `snapshot_cbor` bytes for `options`'s Scope, bypassing the
 * `PostgresBackend` entirely (a direct SQL round trip). Used by the
 * phase-observer and snapshot-cache test suites to assert on the exact
 * persisted bytes rather than on anything the backend's public surface
 * would re-decode/re-validate for them.
 */
export async function readSnapshotCbor(
  options: PostgresBackendOptions
): Promise<Uint8Array> {
  const sql = createOptionsSqlClient(options);

  try {
    const schemaName = requireSchemaName(options);
    const rows = await sql.unsafe<Array<{ snapshot_cbor: Uint8Array }>>(
      `SELECT snapshot_cbor
         FROM "${schemaName}".backend_postgres_snapshots
        WHERE snapshot_id = 1 AND scope = $1`,
      [options.scope ?? DEFAULT_SCOPE]
    );
    const row = rows[0];

    if (row === undefined) {
      throw new Error("expected a persisted snapshot row");
    }

    return new Uint8Array(row.snapshot_cbor);
  } finally {
    await sql.end({ timeout: 0 });
  }
}

/**
 * Overwrites `options`'s Scope's `snapshot_cbor` row directly via SQL,
 * bypassing every backend-owned invariant (`persistStateSnapshot`'s encode,
 * the row lock, everything). Simulates either a byte-level corruption of the
 * stored payload or a same-schema/scope write from an entirely different
 * writer/process, for the issue #108 M3 corruption-injection and
 * cross-process-invalidation coverage.
 */
export async function writeSnapshotCbor(
  options: PostgresBackendOptions,
  bytes: Uint8Array
): Promise<void> {
  const sql = createOptionsSqlClient(options);

  try {
    const schemaName = requireSchemaName(options);
    await sql.unsafe(
      `UPDATE "${schemaName}".backend_postgres_snapshots
          SET snapshot_cbor = $1
        WHERE snapshot_id = 1 AND scope = $2`,
      [bytes, options.scope ?? DEFAULT_SCOPE]
    );
  } finally {
    await sql.end({ timeout: 0 });
  }
}

function requireSchemaName(options: PostgresBackendOptions): string {
  if (options.schemaName === undefined) {
    throw new Error("expected a schema name on the test backend options");
  }

  return options.schemaName;
}

function createOptionsSqlClient(options: PostgresBackendOptions) {
  return postgres({
    connect_timeout: 5,
    database: options.database,
    host: options.host,
    idle_timeout: 1,
    max: 1,
    onnotice: () => undefined,
    password: options.password,
    port: options.port,
    prepare: false,
    username: options.username,
  });
}

function createSqlClient() {
  const environment = readDevenvPostgresEnvironment();

  return postgres({
    connect_timeout: 5,
    database: DEVENV_DATABASE_NAME,
    host: environment.host,
    idle_timeout: 1,
    max: 1,
    onnotice: () => undefined,
    port: environment.port,
    prepare: false,
    username: environment.username,
  });
}

function readDevenvPostgresEnvironment(): DevenvPostgresEnvironment {
  const host = process.env.PGHOST;
  const portValue = process.env.PGPORT;
  const username = process.env.PGUSER ?? process.env.USER;

  if (host === undefined || host.length === 0) {
    throw new Error(
      "PGHOST is missing. Load the repo environment with direnv and start PostgreSQL with `devenv up -d` before running PostgreSQL-backed tests."
    );
  }

  if (portValue === undefined || portValue.length === 0) {
    throw new Error(
      "PGPORT is missing. Load the repo environment with direnv and start PostgreSQL with `devenv up -d` before running PostgreSQL-backed tests."
    );
  }

  if (username === undefined || username.length === 0) {
    throw new Error(
      "PGUSER/USER is missing. PostgreSQL-backed tests require a local database user."
    );
  }

  const port = Number.parseInt(portValue, 10);

  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(
      `PGPORT must be a positive integer, received "${portValue}"`
    );
  }

  return {
    host,
    port,
    username,
  };
}

function assertSchemaName(schemaName: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new Error(`invalid PostgreSQL schema name "${schemaName}"`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
