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
import {
  createCanonicalKernelTestSchema,
  createStoredObjectRecord,
  createStoredSchemaRecord,
} from "@tuvren/kernel-testkit";
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

describe("@tuvren/backend-postgres phase observer seam (issue #108)", () => {
  test("omitting phaseObserver, NOOP_PHASE_OBSERVER, and an active RecordingPhaseObserver all persist identical records", async () => {
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
    // byte-identical snapshot_cbor check).
    const loaded: Array<{ schemaId: string; objectHash: string }> = [];
    for (const backend of [
      defaultBackend,
      explicitNoopBackend,
      recordingBackend,
    ]) {
      await backend.transact(async (tx) => {
        const storedSchema = await tx.schemas.get(schemaRecord.schemaId);
        const storedObject = await tx.objects.get(objectRecord.hash);
        loaded.push({
          objectHash: storedObject?.hash ?? "",
          schemaId: storedSchema?.schemaId ?? "",
        });
      });
    }

    expect(loaded[0]).toEqual(loaded[1]);
    expect(loaded[0]).toEqual(loaded[2]);
    expect(loaded[0]?.schemaId).toBe(schemaRecord.schemaId);
    expect(loaded[0]?.objectHash).toBe(objectRecord.hash);
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
