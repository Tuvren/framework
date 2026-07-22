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

// Issue #108: validates the sqlite backend's PhaseObserver seam is
// behavior-neutral (M1's original noop-vs-absent check plus M2's stronger
// recording-vs-noop check: a RecordingPhaseObserver must persist rows
// byte-identical to NOOP_PHASE_OBSERVER's, not just to the default, so the
// seam is proven neutral even while it is actively timing every phase) and
// that a RecordingPhaseObserver captures the load/validate-loaded/
// validate-lineage-index/validate-committed/write phases a fsck()/
// reclaim() flow actually runs, in plausible order (M2: sub-phases replace
// M1's single unattributed-residual-hiding "validate" phase for this
// backend — see the M2 section of
// `.constitution/reports/108-git-faithful-blob-persistence.md`). M5 moved
// the phased load+validate pass from `health()` to the new `fsck()`
// maintenance method (`health()` is now a lightweight probe with no phases
// to attribute), so the phase-attribution assertions below exercise
// `fsck()`, not `health()`. M6 dropped reclaim()'s former second
// loadValidatedState pass in favor of a single "validate-reclaim-survivors"
// phase over the targeted post-sweep check — see the M6 section of the same
// report.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createRecordingPhaseObserver,
  NOOP_PHASE_OBSERVER,
} from "@tuvren/backend-shared";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
} from "@tuvren/kernel-testkit";
import Database from "better-sqlite3";
import { createSqliteBackend } from "../src/index.js";
import { createTempDatabasePath } from "./backend-sqlite-test-helpers.js";

describe("@tuvren/backend-sqlite phase observer seam (issue #108)", () => {
  test("omitting phaseObserver, NOOP_PHASE_OBSERVER, and an active RecordingPhaseObserver all persist identical rows for an equivalent transact()+fsck() flow", async () => {
    const fixedNow = () => 1_700_000_000_000;
    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const objectRecord = await createStoredObjectRecord(
      new Uint8Array([4, 5, 6]),
      1
    );

    const defaultDatabasePath = createTempDatabasePath();
    const explicitNoopDatabasePath = createTempDatabasePath();
    const recordingDatabasePath = createTempDatabasePath();
    const defaultBackend = createSqliteBackend({
      databasePath: defaultDatabasePath,
      now: fixedNow,
    });
    const explicitNoopBackend = createSqliteBackend({
      databasePath: explicitNoopDatabasePath,
      now: fixedNow,
      phaseObserver: NOOP_PHASE_OBSERVER,
    });
    // M2: a *recording* observer (not just an unused NOOP one) must also
    // leave the persisted rows byte-identical -- proving the seam never
    // alters production bytes/rows even while it is actively timing every
    // phase, which the M1 noop-vs-default comparison alone could not show.
    const recordingBackend = createSqliteBackend({
      databasePath: recordingDatabasePath,
      now: fixedNow,
      phaseObserver: createRecordingPhaseObserver(),
    });

    try {
      for (const backend of [
        defaultBackend,
        explicitNoopBackend,
        recordingBackend,
      ]) {
        await backend.transact(async (tx) => {
          await tx.schemas.put(schemaRecord);
          await tx.objects.put(objectRecord);
        });
        const outcome = await backend.fsck();
        ok(outcome.ok, "expected fsck() to report ok");
      }

      for (const table of ["objects", "schemas"] as const) {
        const orderColumn = table === "objects" ? "hash" : "schema_id";
        const defaultRows = readTableRows(
          defaultDatabasePath,
          table,
          orderColumn
        );
        deepStrictEqual(
          readTableRows(explicitNoopDatabasePath, table, orderColumn),
          defaultRows
        );
        deepStrictEqual(
          readTableRows(recordingDatabasePath, table, orderColumn),
          defaultRows
        );
      }
    } finally {
      await defaultBackend.close();
      await explicitNoopBackend.close();
      await recordingBackend.close();
    }
  });

  test("a RecordingPhaseObserver captures every persistence phase in the order fsck()/reclaim() run them", async () => {
    const observer = createRecordingPhaseObserver();
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
      phaseObserver: observer,
    });

    try {
      const schema = createCanonicalKernelTestSchema();
      const objectRecord = await createStoredObjectRecord(
        new Uint8Array([1, 2, 3]),
        1
      );

      await backend.transact(async (tx) => {
        await tx.schemas.put(createStoredSchemaRecord(schema, 1));
        await tx.objects.put(objectRecord);
      });

      observer.reset();

      const fsckOutcome = await backend.fsck();
      ok(fsckOutcome.ok, "expected fsck() to report ok");

      const fsckPhases = observer.samples.map((sample) => sample.phase);
      for (const phase of [
        "load",
        "validate-loaded",
        "validate-lineage-index",
        "validate-committed",
      ] as const) {
        strictEqual(
          fsckPhases.filter((sample) => sample === phase).length,
          1,
          `expected exactly one ${phase} phase from fsck()'s single loadValidatedState call`
        );
      }
      ok(
        fsckPhases.indexOf("load") < fsckPhases.indexOf("validate-loaded"),
        "expected load to be attributed before validate-loaded"
      );
      ok(
        fsckPhases.indexOf("validate-loaded") <
          fsckPhases.indexOf("validate-lineage-index"),
        "expected validate-loaded to be attributed before validate-lineage-index"
      );
      ok(
        fsckPhases.indexOf("validate-lineage-index") <
          fsckPhases.indexOf("validate-committed"),
        "expected validate-lineage-index to be attributed before validate-committed"
      );

      observer.reset();

      if (backend.reclaim === undefined) {
        throw new Error("expected sqlite backend to implement reclaim()");
      }
      await backend.reclaim({ nowMs: fixedReclaimClock() });

      const reclaimPhases = observer.samples.map((sample) => sample.phase);
      // Issue #108 M6: reclaim() now calls loadValidatedState only once (the
      // pre-sweep gate), so "load" and every "validate-*" sub-phase from that
      // call appear exactly once; the former second loadValidatedState pass
      // is replaced by the single "validate-reclaim-survivors" phase, and
      // "write" still appears at least twice (the sweep's batched deletes,
      // then COMMIT).
      for (const phase of [
        "load",
        "validate-loaded",
        "validate-lineage-index",
        "validate-committed",
        "validate-reclaim-survivors",
      ] as const) {
        strictEqual(
          reclaimPhases.filter((sample) => sample === phase).length,
          1,
          `expected exactly one ${phase} phase from reclaim()'s single loadValidatedState call plus its targeted post-sweep check`
        );
      }
      ok(
        reclaimPhases.filter((phase) => phase === "write").length >= 2,
        "expected at least two write phases from reclaim()'s delete and commit"
      );
      ok(
        reclaimPhases.indexOf("validate-committed") <
          reclaimPhases.indexOf("validate-reclaim-survivors"),
        "expected the pre-sweep validate-committed phase to be attributed before the post-sweep validate-reclaim-survivors phase"
      );

      for (const sample of observer.samples) {
        ok(
          sample.durationNs >= 0,
          `expected a non-negative duration for phase ${sample.phase}`
        );
      }
    } finally {
      await backend.close();
    }
  });

  test("a RecordingPhaseObserver captures a validate-write-set phase from transact()'s pre-commit write-set check (issue #108 B2 closure)", async () => {
    const observer = createRecordingPhaseObserver();
    const backend = createSqliteBackend({
      databasePath: createTempDatabasePath(),
      phaseObserver: observer,
    });

    try {
      const schema = createCanonicalKernelTestSchema();
      const schemaRecord = createStoredSchemaRecord(schema, 1);
      const objectRecord = await createStoredObjectRecord(
        new Uint8Array([9, 9, 9]),
        1
      );

      observer.reset();

      await backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.objects.put(objectRecord);
      });

      const transactPhases = observer.samples.map((sample) => sample.phase);
      strictEqual(
        transactPhases.filter((phase) => phase === "validate-write-set").length,
        1,
        "expected exactly one validate-write-set phase from transact()'s pre-commit check"
      );
      // transact() has no decode/encode/load/validate-committed seam (row-
      // per-record writes, not a full-blob rewrite), so no other phase should
      // ever appear on this path.
      for (const phase of transactPhases) {
        strictEqual(
          phase,
          "validate-write-set",
          `expected transact() to report only validate-write-set phases, saw ${phase}`
        );
      }
    } finally {
      await backend.close();
    }
  });
});

function fixedReclaimClock(): number {
  return 1_700_000_100_000;
}

/** Reads every row of `table` (ordered deterministically) via a read-only connection. */
function readTableRows(
  databasePath: string,
  table: string,
  orderColumn: string
): unknown[] {
  const db = new Database(databasePath, { readonly: true });

  try {
    const rows = db
      .prepare(`SELECT * FROM ${table} ORDER BY ${orderColumn}`)
      .all();

    return rows.map((row) => normalizeRow(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

/** Converts Buffer columns to hex strings so `deepStrictEqual` compares raw bytes exactly. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = Buffer.isBuffer(value) ? value.toString("hex") : value;
  }

  return normalized;
}
