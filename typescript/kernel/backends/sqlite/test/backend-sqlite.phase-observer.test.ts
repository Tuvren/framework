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

// Issue #108 (M1): validates the sqlite backend's PhaseObserver seam is
// behavior-neutral by default (no observer and an explicit NOOP_PHASE_OBSERVER
// must persist identical rows for an equivalent transact()+health() flow) and
// that a RecordingPhaseObserver captures the load/validate/write phases a
// health()+reclaim() flow actually runs, in plausible order.

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

describe("@tuvren/backend-sqlite phase observer seam (issue #108 M1)", () => {
  test("omitting phaseObserver and passing NOOP_PHASE_OBSERVER persist identical rows for an equivalent transact()+health() flow", async () => {
    const fixedNow = () => 1_700_000_000_000;
    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const objectRecord = await createStoredObjectRecord(
      new Uint8Array([4, 5, 6]),
      1
    );

    const defaultDatabasePath = createTempDatabasePath();
    const explicitNoopDatabasePath = createTempDatabasePath();
    const defaultBackend = createSqliteBackend({
      databasePath: defaultDatabasePath,
      now: fixedNow,
    });
    const explicitNoopBackend = createSqliteBackend({
      databasePath: explicitNoopDatabasePath,
      now: fixedNow,
      phaseObserver: NOOP_PHASE_OBSERVER,
    });

    try {
      for (const backend of [defaultBackend, explicitNoopBackend]) {
        await backend.transact(async (tx) => {
          await tx.schemas.put(schemaRecord);
          await tx.objects.put(objectRecord);
        });
        const outcome = await backend.health();
        ok(outcome.ok, "expected health() to report ok");
      }

      deepStrictEqual(
        readTableRows(defaultDatabasePath, "objects", "hash"),
        readTableRows(explicitNoopDatabasePath, "objects", "hash")
      );
      deepStrictEqual(
        readTableRows(defaultDatabasePath, "schemas", "schema_id"),
        readTableRows(explicitNoopDatabasePath, "schemas", "schema_id")
      );
    } finally {
      await defaultBackend.close();
      await explicitNoopBackend.close();
    }
  });

  test("a RecordingPhaseObserver captures every persistence phase in the order health()/reclaim() run them", async () => {
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

      const healthOutcome = await backend.health();
      ok(healthOutcome.ok, "expected health() to report ok");

      const healthPhases = observer.samples.map((sample) => sample.phase);
      strictEqual(
        healthPhases.filter((phase) => phase === "load").length,
        1,
        "expected exactly one load phase from health()'s single loadValidatedState call"
      );
      strictEqual(
        healthPhases.filter((phase) => phase === "validate").length,
        1,
        "expected exactly one validate phase from health()'s single loadValidatedState call"
      );
      ok(
        healthPhases.indexOf("load") < healthPhases.indexOf("validate"),
        "expected load to be attributed before validate"
      );

      observer.reset();

      if (backend.reclaim === undefined) {
        throw new Error("expected sqlite backend to implement reclaim()");
      }
      await backend.reclaim({ nowMs: fixedReclaimClock() });

      const reclaimPhases = observer.samples.map((sample) => sample.phase);
      // reclaim() runs loadValidatedState twice (before and after the sweep's
      // deletions) plus its own delete/commit write phases, so "load" and
      // "validate" must each appear twice and "write" at least twice.
      strictEqual(
        reclaimPhases.filter((phase) => phase === "load").length,
        2,
        "expected two load phases from reclaim()'s two loadValidatedState calls"
      );
      strictEqual(
        reclaimPhases.filter((phase) => phase === "validate").length,
        2,
        "expected two validate phases from reclaim()'s two loadValidatedState calls"
      );
      ok(
        reclaimPhases.filter((phase) => phase === "write").length >= 2,
        "expected at least two write phases from reclaim()'s delete and commit"
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
