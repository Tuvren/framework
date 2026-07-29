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
  NOOP_PHASE_OBSERVER,
  type PhaseObserver,
} from "@tuvren/backend-shared";
import { assertScope } from "@tuvren/core";
import type { TransactionSql } from "postgres";
import { persistenceError } from "./postgres-errors.js";
import {
  CURRENT_SNAPSHOT_VERSION,
  decodeSnapshot,
} from "./postgres-legacy-snapshot-decode.js";
import type { BackendState } from "./postgres-records.js";
import { LEGACY_SNAPSHOTS_TABLE } from "./postgres-schema.js";
import { qualifyIdentifier } from "./postgres-sql.js";
import { insertBackendStateRows } from "./postgres-state-persist.js";

type Tx = TransactionSql<Record<string, never>>;

interface LegacySnapshotMetadataRow {
  schema_version: number;
  scope: string;
}

interface LegacySnapshotBlobRow {
  snapshot_cbor: Uint8Array;
}

/**
 * One-shot open-time migration: for each legacy blob-per-scope row, decode the
 * snapshot into {@link BackendState}, insert family rows under that Scope, then
 * drop the legacy snapshots table. Must run inside the schema-init advisory
 * lock transaction; the whole explode is charged to the `blob-migration`
 * phase so a slow first open of a legacy database is attributable.
 *
 * The migration is one-way (ADR-067: downgrade is not supported) and
 * all-or-nothing: any failure rolls back the enclosing schema-init
 * transaction, leaving the legacy table intact for the next attempt.
 */
export async function explodeLegacyBlobSnapshots(
  tx: Tx,
  schemaName: string,
  phaseObserver: PhaseObserver = NOOP_PHASE_OBSERVER
): Promise<void> {
  const snapshotsTable = qualifyIdentifier(schemaName, LEGACY_SNAPSHOTS_TABLE);
  const endMigration = phaseObserver.startPhase("blob-migration");

  try {
    // Fetch scope metadata first and each blob individually, so peak
    // resident memory is bounded by the largest single Scope (whose blob a
    // decode needs whole anyway), not the sum of every Scope's blob.
    const scopes = await tx.unsafe<LegacySnapshotMetadataRow[]>(
      `SELECT scope, schema_version FROM ${snapshotsTable} ORDER BY scope`
    );

    for (const row of scopes) {
      if (row.schema_version !== CURRENT_SNAPSHOT_VERSION) {
        throw persistenceError(
          "postgres backend cannot migrate a legacy blob snapshot with an unsupported schema version",
          "postgres_backend_blob_migration_version_unsupported",
          {
            actualVersion: row.schema_version,
            expectedVersion: CURRENT_SNAPSHOT_VERSION,
            scope: row.scope,
          }
        );
      }

      const blobs = await tx.unsafe<LegacySnapshotBlobRow[]>(
        `SELECT snapshot_cbor FROM ${snapshotsTable} WHERE scope = $1 ORDER BY snapshot_id`,
        [row.scope]
      );
      const blob = blobs[0];

      if (blob === undefined) {
        throw persistenceError(
          "postgres backend legacy blob snapshot disappeared mid-migration",
          "postgres_backend_blob_migration_row_missing",
          { scope: row.scope }
        );
      }

      // The legacy primary key was (snapshot_id, scope): the legacy writer
      // only ever wrote snapshot_id = 1, so exactly one row per scope is the
      // load-bearing assumption `blobs[0]` below relies on. ADR-067 decision
      // 5 forbids losing any committed logical state, so a second row for
      // the same scope — which `blobs[0]` would otherwise silently drop —
      // must fail loudly instead of being ignored.
      if (blobs.length > 1) {
        throw persistenceError(
          "postgres backend found more than one legacy blob snapshot row for a scope",
          "postgres_backend_blob_migration_ambiguous_rows",
          { rowCount: blobs.length, scope: row.scope }
        );
      }

      let state: BackendState;
      try {
        state = decodeSnapshot(new Uint8Array(blob.snapshot_cbor));
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

      try {
        assertScope(row.scope);
        await insertBackendStateRows(tx, schemaName, row.scope, state);
      } catch (error: unknown) {
        throw persistenceError(
          "postgres backend failed to insert exploded family rows during blob migration",
          "postgres_backend_blob_migration_insert_failed",
          { scope: row.scope },
          error
        );
      }
    }

    await tx.unsafe(`DROP TABLE ${snapshotsTable}`);
  } finally {
    endMigration();
  }
}
