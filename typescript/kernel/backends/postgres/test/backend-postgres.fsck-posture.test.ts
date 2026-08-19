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

// Round-3 review P2 — posture validation depth + placement: `fsck()`'s
// `loadValidatedState` now calls `validateRelationalSchemaPosture` first
// (mirroring the SQLite backend's `validateMigrationState` gate at the top
// of its own `loadValidatedState`), so a dropped required index or a
// collation/deferred-FK drift is caught by `fsck()`, not just by `health()`.
// This file covers that placement plus the two new posture aspects
// (`COLLATE "C"` and `DEFERRABLE INITIALLY DEFERRED`) `validateRelational
// SchemaPosture` now checks beyond table/index existence. See
// `backend-postgres.health-fsck.test.ts` for the pre-existing health()-side
// index-drop coverage this suite mirrors on the fsck() path (that file is
// under concurrent edit and is intentionally left untouched here).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPostgresBackend } from "../src/index.js";
import { RELATIONAL_REQUIRED_INDEXES } from "../src/lib/postgres-schema.js";
import { qualifyIdentifier, quoteIdentifier } from "../src/lib/postgres-sql.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createAdminClient,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const RELATIONAL_INDEXES_MISSING_ERROR_PATTERN =
  /relational indexes are missing/u;
const RELATIONAL_COLLATION_INVALID_ERROR_PATTERN = /must use COLLATE "C"/u;
const RELATIONAL_FKS_NOT_DEFERRABLE_ERROR_PATTERN =
  /DEFERRABLE INITIALLY DEFERRED/u;
const RELATIONAL_FKS_MISSING_ERROR_PATTERN = /foreign keys are missing/u;

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres fsck()/health() posture validation", () => {
  test("fsck() reports a posture failure when a required relational index is dropped", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);
    const schemaName = options.schemaName ?? "public";

    try {
      const baselineHealth = await backend.health();
      expect(baselineHealth.ok).toBe(true);
      const baselineFsck = await backend.fsck();
      expect(baselineFsck.ok).toBe(true);

      const [droppedIndex] = RELATIONAL_REQUIRED_INDEXES;
      if (droppedIndex === undefined) {
        throw new Error("expected at least one required relational index");
      }

      const admin = createAdminClient(options);
      try {
        await admin.unsafe(
          `DROP INDEX ${quoteIdentifier(schemaName)}.${quoteIdentifier(droppedIndex)}`
        );
      } finally {
        await admin.end({ timeout: 0 });
      }

      const fsck = await backend.fsck();
      expect(fsck.ok).toBe(false);
      expect(fsck.ok === false ? fsck.reason : undefined).toMatch(
        RELATIONAL_INDEXES_MISSING_ERROR_PATTERN
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test('health() reports a posture failure when a required TEXT column\'s collation drifts away from "C"', async () => {
    // health() memoizes a successful posture validation for
    // POSTURE_REVALIDATION_INTERVAL_MS (60s), keyed on `postureNow` (a wall
    // clock independent of the injectable ADR-050 domain clock `now`, which
    // only governs lease/reclaim semantics). Advance `postureNow` past that
    // window before the post-tamper probe so the memo does not mask the
    // drift this test injects.
    let simulatedNowMs = Date.now();
    const options = createPostgresTestBackendOptions({
      postureNow: () => simulatedNowMs,
    });
    const backend = createPostgresBackend(options);
    const schemaName = options.schemaName ?? "public";

    try {
      const baseline = await backend.health();
      expect(baseline.ok).toBe(true);

      const admin = createAdminClient(options);
      try {
        await admin.unsafe(
          `ALTER TABLE ${qualifyIdentifier(schemaName, "objects")}
             ALTER COLUMN media_type TYPE TEXT COLLATE "POSIX"`
        );
      } finally {
        await admin.end({ timeout: 0 });
      }

      simulatedNowMs += 60_001;
      const health = await backend.health();
      expect(health.ok).toBe(false);
      expect(health.ok === false ? health.reason : undefined).toMatch(
        RELATIONAL_COLLATION_INVALID_ERROR_PATTERN
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("health() reports a posture failure when a foreign key is no longer DEFERRABLE INITIALLY DEFERRED", async () => {
    // See the collation test above: advance `postureNow` past
    // POSTURE_REVALIDATION_INTERVAL_MS so health()'s posture memo does not
    // mask the drift this test injects between the two health() calls.
    let simulatedNowMs = Date.now();
    const options = createPostgresTestBackendOptions({
      postureNow: () => simulatedNowMs,
    });
    const backend = createPostgresBackend(options);
    const schemaName = options.schemaName ?? "public";

    try {
      const baseline = await backend.health();
      expect(baseline.ok).toBe(true);

      const admin = createAdminClient(options);
      try {
        const turnTreesTable = qualifyIdentifier(schemaName, "turn_trees");
        const constraints = await admin.unsafe<Array<{ conname: string }>>(
          `SELECT con.conname
             FROM pg_constraint con
             JOIN pg_class cls ON cls.oid = con.conrelid
             JOIN pg_namespace ns ON ns.oid = cls.relnamespace
            WHERE ns.nspname = $1
              AND cls.relname = 'turn_trees'
              AND con.contype = 'f'`,
          [schemaName]
        );
        const [constraint] = constraints;
        if (constraint === undefined) {
          throw new Error(
            "expected turn_trees to have at least one foreign key"
          );
        }

        await admin.unsafe(
          `ALTER TABLE ${turnTreesTable}
             ALTER CONSTRAINT ${quoteIdentifier(constraint.conname)}
             NOT DEFERRABLE`
        );
      } finally {
        await admin.end({ timeout: 0 });
      }

      simulatedNowMs += 60_001;
      const health = await backend.health();
      expect(health.ok).toBe(false);
      expect(health.ok === false ? health.reason : undefined).toMatch(
        RELATIONAL_FKS_NOT_DEFERRABLE_ERROR_PATTERN
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("health() reports a posture failure when a required foreign key is dropped", async () => {
    let simulatedNowMs = Date.now();
    const options = createPostgresTestBackendOptions({
      postureNow: () => simulatedNowMs,
    });
    const backend = createPostgresBackend(options);
    const schemaName = options.schemaName ?? "public";

    try {
      const baseline = await backend.health();
      expect(baseline.ok).toBe(true);

      const admin = createAdminClient(options);
      try {
        const turnTreesTable = qualifyIdentifier(schemaName, "turn_trees");
        const constraints = await admin.unsafe<Array<{ conname: string }>>(
          `SELECT con.conname
             FROM pg_constraint con
             JOIN pg_class cls ON cls.oid = con.conrelid
             JOIN pg_namespace ns ON ns.oid = cls.relnamespace
            WHERE ns.nspname = $1
              AND cls.relname = 'turn_trees'
              AND con.contype = 'f'`,
          [schemaName]
        );
        const [constraint] = constraints;
        if (constraint === undefined) {
          throw new Error(
            "expected turn_trees to have at least one foreign key"
          );
        }

        await admin.unsafe(
          `ALTER TABLE ${turnTreesTable}
             DROP CONSTRAINT ${quoteIdentifier(constraint.conname)}`
        );
      } finally {
        await admin.end({ timeout: 0 });
      }

      simulatedNowMs += 60_001;
      const health = await backend.health();
      expect(health.ok).toBe(false);
      expect(health.ok === false ? health.reason : undefined).toMatch(
        RELATIONAL_FKS_MISSING_ERROR_PATTERN
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
