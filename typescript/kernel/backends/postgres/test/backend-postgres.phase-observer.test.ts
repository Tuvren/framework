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

// Issue #108: validates the postgres backend's PhaseObserver seam is
// behavior-neutral (M1's original noop-vs-absent check plus M2's stronger
// recording-vs-noop check: a RecordingPhaseObserver must persist
// snapshot_cbor byte-identical to NOOP_PHASE_OBSERVER's, not just to the
// default, so the seam is proven neutral even while it is actively timing
// every phase) and that a RecordingPhaseObserver captures the
// decode/validate/encode/write/lock-wait phases of a transact() call in the
// order the persistence path actually runs them.

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
  readSnapshotCbor,
} from "./postgres-test-helpers.js";

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres phase observer seam (issue #108)", () => {
  test("omitting phaseObserver, NOOP_PHASE_OBSERVER, and an active RecordingPhaseObserver all persist byte-identical snapshot_cbor", async () => {
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
    // M2: a *recording* observer (not just an unused NOOP one) must also
    // leave snapshot_cbor byte-identical -- proving the seam never alters
    // production bytes even while it is actively timing every phase, which
    // the M1 noop-vs-default comparison alone could not show.
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

    const defaultBytes = await readSnapshotCbor(defaultOptions);
    const explicitNoopBytes = await readSnapshotCbor(explicitNoopOptions);
    const recordingBytes = await readSnapshotCbor(recordingOptions);

    expect(
      Buffer.from(defaultBytes).equals(Buffer.from(explicitNoopBytes))
    ).toBe(true);
    expect(Buffer.from(defaultBytes).equals(Buffer.from(recordingBytes))).toBe(
      true
    );
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
