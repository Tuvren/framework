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

// Issue #108 (M1): validates the postgres backend's PhaseObserver seam is
// behavior-neutral by default (no observer and an explicit NOOP_PHASE_OBSERVER
// must persist byte-identical snapshot_cbor for equivalent writes) and that a
// RecordingPhaseObserver captures the decode/validate/encode/write/lock-wait
// phases of a transact() call in the order the persistence path actually runs
// them.

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
import postgres from "postgres";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres phase observer seam (issue #108 M1)", () => {
  test("omitting phaseObserver and passing NOOP_PHASE_OBSERVER persist byte-identical snapshot_cbor", async () => {
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

    const defaultBackend = createPostgresBackend(defaultOptions);
    const explicitNoopBackend = createPostgresBackend(explicitNoopOptions);

    for (const backend of [defaultBackend, explicitNoopBackend]) {
      await backend.transact(async (tx) => {
        await tx.schemas.put(schemaRecord);
        await tx.objects.put(objectRecord);
      });
    }

    const defaultBytes = await readSnapshotCbor(defaultOptions);
    const explicitNoopBytes = await readSnapshotCbor(explicitNoopOptions);

    expect(
      Buffer.from(defaultBytes).equals(Buffer.from(explicitNoopBytes))
    ).toBe(true);
  });

  test("a RecordingPhaseObserver captures every persistence phase in the order transact() runs them", async () => {
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
    expect(phases).toContain("decode");
    expect(phases).toContain("validate");
    expect(phases).toContain("encode");
    expect(phases).toContain("write");

    for (const sample of observer.samples) {
      expect(sample.durationNs).toBeGreaterThanOrEqual(0);
    }

    // The persistence path decodes the row-locked snapshot, validates the
    // resulting draft, encodes it back to CBOR, then writes/commits it — so
    // the first occurrence of each phase must appear in that relative order.
    const decodeIndex = phases.indexOf("decode");
    const validateIndex = phases.indexOf("validate");
    const encodeIndex = phases.indexOf("encode");
    const writeIndex = phases.indexOf("write");

    expect(decodeIndex).toBeGreaterThanOrEqual(0);
    expect(validateIndex).toBeGreaterThan(decodeIndex);
    expect(encodeIndex).toBeGreaterThan(validateIndex);
    expect(writeIndex).toBeGreaterThan(encodeIndex);
  });
});

/** Reads the raw `snapshot_cbor` bytes for the default Scope's snapshot row. */
async function readSnapshotCbor(
  options: ReturnType<typeof createPostgresTestBackendOptions>
): Promise<Uint8Array> {
  const sql = postgres({
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

  try {
    const schemaName = options.schemaName;

    if (schemaName === undefined) {
      throw new Error("expected a schema name on the test backend options");
    }

    const rows = await sql.unsafe<Array<{ snapshot_cbor: Uint8Array }>>(
      `SELECT snapshot_cbor
         FROM "${schemaName}".backend_postgres_snapshots
        WHERE snapshot_id = 1 AND scope = $1`,
      [DEFAULT_SCOPE]
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
