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
  const sql = createSqlClient();

  try {
    const result = await sql<{ ready: number }[]>`SELECT 1 AS ready`;

    if (result[0]?.ready !== 1) {
      throw new Error("devenv postgres readiness query returned no row");
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
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
      "PGHOST is missing. Run PostgreSQL-backed tests through `devenv up` and `devenv shell`."
    );
  }

  if (portValue === undefined || portValue.length === 0) {
    throw new Error(
      "PGPORT is missing. Run PostgreSQL-backed tests through `devenv up` and `devenv shell`."
    );
  }

  if (username === undefined || username.length === 0) {
    throw new Error(
      "PGUSER/USER is missing. PostgreSQL-backed tests require a local database user."
    );
  }

  const port = Number.parseInt(portValue, 10);

  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`PGPORT must be a positive integer, received "${portValue}"`);
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
