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

import type { EpochMs, Scope } from "@tuvren/core";
import type { TransactionSql } from "postgres";
import { decodeSnapshot } from "./postgres-backend-persistence.js";
import { persistenceError } from "./postgres-errors.js";
import type { BackendState } from "./postgres-records.js";
import { LEGACY_SNAPSHOTS_TABLE } from "./postgres-schema.js";
import { qualifyIdentifier } from "./postgres-sql.js";
import { insertBackendStateRows } from "./postgres-state-persist.js";

type Tx = TransactionSql<Record<string, never>>;

interface LegacySnapshotRow {
  schema_version: number;
  scope: string;
  snapshot_cbor: Uint8Array;
}

/**
 * One-shot open-time migration: for each legacy blob-per-scope row, decode the
 * snapshot into {@link BackendState}, insert family rows under that Scope, then
 * drop the legacy snapshots table. Must run inside the schema-init advisory
 * lock transaction.
 */
export async function explodeLegacyBlobSnapshots(
  tx: Tx,
  schemaName: string,
  _now: () => EpochMs
): Promise<void> {
  const snapshotsTable = qualifyIdentifier(schemaName, LEGACY_SNAPSHOTS_TABLE);
  const rows = await tx.unsafe<LegacySnapshotRow[]>(
    `SELECT scope, schema_version, snapshot_cbor FROM ${snapshotsTable}`
  );

  for (const row of rows) {
    let state: BackendState;
    try {
      state = decodeSnapshot(new Uint8Array(row.snapshot_cbor));
    } catch (error: unknown) {
      throw persistenceError(
        "postgres backend failed to decode a legacy blob snapshot during migration",
        "postgres_backend_blob_migration_decode_failed",
        {
          scope: row.scope,
          schemaVersion: row.schema_version,
        },
        error
      );
    }

    await insertBackendStateRows(tx, schemaName, row.scope as Scope, state);
  }

  await tx.unsafe(`DROP TABLE ${snapshotsTable}`);
}
