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

// Issue #108 / #110: validates the postgres backend's PhaseObserver seam is
// behavior-neutral under the relational write path (ADR-067): a
// RecordingPhaseObserver must leave durable rows identical to NOOP /
// omitted observers, and must capture the phases the relational transact()
// path actually runs (lock-wait → validate-write-set → write) rather than
// the retired blob decode/encode phases.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createRecordingPhaseObserver,
  NOOP_PHASE_OBSERVER,
} from "@tuvren/backend-shared";
import { DEFAULT_SCOPE } from "@tuvren/core";
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
} from "@tuvren/kernel-testkit";
import type { PostgresBackendOptions } from "../src/index.js";
import { createPostgresBackend } from "../src/index.js";
import { qualifyIdentifier } from "../src/lib/postgres-sql.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createAdminClient,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

/**
 * Dumps every column of the seeded `objects` and `schemas` rows for one
 * backend's own schema/scope partition — the full family-table content the
 * PhaseObserver seam must leave byte-identical across every construction
 * path, not just the two identity fields the caller already knows.
 */
async function dumpFamilyRows(
  options: PostgresBackendOptions,
  schemaId: string,
  objectHash: string
): Promise<{
  objectRow: {
    byteLength: number;
    bytes: number[];
    createdAtMs: number;
    mediaType: string;
  } | null;
  schemaRow: { createdAtMs: number; schemaCbor: number[] } | null;
}> {
  const schemaName = options.schemaName ?? "public";
  const admin = createAdminClient(options);

  try {
    const objectRows = await admin.unsafe<
      Array<{
        byte_length: number;
        bytes: Uint8Array;
        created_at_ms: number;
        media_type: string;
      }>
    >(
      `SELECT media_type, bytes, byte_length, created_at_ms
         FROM ${qualifyIdentifier(schemaName, "objects")}
        WHERE scope = $1 AND hash = $2`,
      [DEFAULT_SCOPE, objectHash]
    );
    const schemaRows = await admin.unsafe<
      Array<{ created_at_ms: number; schema_cbor: Uint8Array }>
    >(
      `SELECT schema_cbor, created_at_ms
         FROM ${qualifyIdentifier(schemaName, "schemas")}
        WHERE scope = $1 AND schema_id = $2`,
      [DEFAULT_SCOPE, schemaId]
    );

    const objectRow = objectRows[0];
    const schemaRow = schemaRows[0];

    return {
      objectRow:
        objectRow === undefined
          ? null
          : {
              byteLength: Number(objectRow.byte_length),
              bytes: Array.from(objectRow.bytes),
              createdAtMs: Number(objectRow.created_at_ms),
              mediaType: objectRow.media_type,
            },
      schemaRow:
        schemaRow === undefined
          ? null
          : {
              createdAtMs: Number(schemaRow.created_at_ms),
              schemaCbor: Array.from(schemaRow.schema_cbor),
            },
    };
  } finally {
    await admin.end({ timeout: 0 });
  }
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres phase observer seam (ADR-067 relational persistence)", () => {
  test("omitting phaseObserver, NOOP_PHASE_OBSERVER, and an active RecordingPhaseObserver all persist identical records", async () => {
    // A fixed clock is load-bearing here: created_at_ms is part of the
    // row-for-row comparison below, so every construction must stamp the
    // same value rather than drifting across real wall-clock reads.
    const fixedNow = () => 1_700_000_000_000;
    const schema = createCanonicalKernelTestSchema();
    const schemaRecord = createStoredSchemaRecord(schema, 1);
    const objectRecord = await createStoredObjectRecord(
      new Uint8Array([7, 7, 7]),
      1
    );

    const defaultOptions = createPostgresTestBackendOptions({
      now: fixedNow,
    });
    const explicitNoopOptions = createPostgresTestBackendOptions({
      now: fixedNow,
      phaseObserver: NOOP_PHASE_OBSERVER,
    });
    const recordingOptions = createPostgresTestBackendOptions({
      now: fixedNow,
      phaseObserver: createRecordingPhaseObserver(),
    });

    const defaultBackend = createPostgresBackend(defaultOptions);
    const explicitNoopBackend = createPostgresBackend(explicitNoopOptions);
    const recordingBackend = createPostgresBackend(recordingOptions);

    for (const backend of [
      defaultBackend,
      explicitNoopBackend,
      recordingBackend,
    ]) {
      await backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.objects.put(objectRecord);
      });
    }

    // Behavior-neutral seam: every construction path must leave the same
    // durable rows for the same inputs (relational equivalent of the old
    // byte-identical snapshot_cbor check) — dumped and compared field-for-field
    // across all family-table columns the repository surface itself exposed
    // above (objects: media_type/bytes/byte_length/created_at_ms; schemas:
    // schema_cbor/created_at_ms), not just the two identity keys the caller
    // already knows.
    const dumps = await Promise.all(
      [defaultOptions, explicitNoopOptions, recordingOptions].map((options) =>
        dumpFamilyRows(options, schemaRecord.schemaId, objectRecord.hash)
      )
    );

    for (const dump of dumps) {
      expect(dump.objectRow).not.toBeNull();
      expect(dump.schemaRow).not.toBeNull();
    }

    expect(dumps[1]).toEqual(dumps[0]);
    expect(dumps[2]).toEqual(dumps[0]);
    expect(dumps[0]?.objectRow).toEqual({
      byteLength: objectRecord.byteLength,
      bytes: Array.from(objectRecord.bytes),
      createdAtMs: objectRecord.createdAtMs,
      mediaType: objectRecord.mediaType,
    });
    expect(dumps[0]?.schemaRow).toEqual({
      createdAtMs: schemaRecord.createdAtMs,
      schemaCbor: Array.from(schemaRecord.schemaCbor),
    });

    await defaultBackend.destroy();
    await explicitNoopBackend.destroy();
    await recordingBackend.destroy();
  });

  test("a RecordingPhaseObserver captures every relational persistence phase in the order transact() runs them", async () => {
    const observer = createRecordingPhaseObserver();
    const options = createPostgresTestBackendOptions({
      phaseObserver: observer,
    });
    const backend = createPostgresBackend(options);
    const schema = createCanonicalKernelTestSchema();
    const objectRecord = await createStoredObjectRecord(
      new Uint8Array([1, 2, 3]),
      1
    );

    await backend.transact(async (tx) => {
      await tx.schemas.put(createStoredSchemaRecord(schema, 1));
      await tx.objects.put(objectRecord);
    });

    const phases = observer.samples.map((sample) => sample.phase);

    expect(phases).toContain("lock-wait");
    expect(phases).toContain("validate-write-set");
    expect(phases).toContain("write");

    for (const sample of observer.samples) {
      expect(sample.durationNs).toBeGreaterThanOrEqual(0);
    }

    // Relational path: queue for the connection, re-validate the write set,
    // then COMMIT. No whole-blob decode/encode phases remain.
    const lockWaitIndex = phases.indexOf("lock-wait");
    const validateIndex = phases.indexOf("validate-write-set");
    const writeIndex = phases.indexOf("write");

    expect(lockWaitIndex).toBeGreaterThanOrEqual(0);
    expect(validateIndex).toBeGreaterThan(lockWaitIndex);
    expect(writeIndex).toBeGreaterThan(validateIndex);
  });
});
