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

// Round-3 review P1 — NUL-identifier boundary validation: caller-supplied
// identifier/text fields now land directly in a relational TEXT column
// (ADR-067 moved them out of a CBOR blob, where an embedded U+0000 byte
// round-tripped without complaint). PostgreSQL's wire protocol cannot encode
// NUL in text/varchar and previously surfaced as a raw SQLSTATE 22021
// `postgres_backend_engine_error` deep in the driver. This suite proves the
// repository boundary now rejects it early with a typed
// `postgres_backend_unstorable_text` error instead, and that ordinary
// (NUL-free) writes are unaffected.
//
// Round-6 review P2 — btree index-row-size boundary validation: the same
// `assertPostgresStorableText` guard also rejects a value whose UTF-8 byte
// length exceeds 512 bytes (see MAX_STORABLE_TEXT_BYTES's docblock in
// postgres-sql.ts for the worst-composite arithmetic). Every family table in
// migrations/0001_relational_schema.sql puts caller-supplied identifiers
// directly into btree primary keys/indexes, and PostgreSQL caps a single
// btree index tuple at 2704 bytes regardless of the column's own TEXT type
// limit — an incompressible, sufficiently long identifier previously failed
// with an untyped `postgres_backend_engine_error` (SQLSTATE 54000) deep in
// the driver instead of a typed, predictable error. This suite additionally
// proves: an over-long identifier is now rejected with a typed
// `postgres_backend_text_too_long` error before reaching the engine; a value
// just under the bound with an embedded NUL still yields
// `postgres_backend_unstorable_text` (the two checks do not shadow each
// other in the wrong order); and the worst real composite this repository
// builds — the observe_annotations (scope, record_key) primary key, at the
// 512-byte bound on its only unbounded field (runId) — actually inserts,
// proving the arithmetic left the promised headroom under the btree limit.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  type StoredObserveAnnotation,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const NUL = "\u0000";
const UNSTORABLE_TEXT_CODE = "postgres_backend_unstorable_text";
const TEXT_TOO_LONG_CODE = "postgres_backend_text_too_long";
// Mirrors MAX_STORABLE_TEXT_BYTES in ../src/lib/postgres-sql.ts. Kept as a
// literal here (rather than imported) so this suite fails loudly if the
// implementation's bound ever drifts from what these tests assume.
const MAX_STORABLE_TEXT_BYTES = 512;

/** Builds an ASCII (1 byte/char) identifier of an exact total byte length. */
function asciiIdOfLength(label: string, totalBytes: number): string {
  const prefix = `${label}_`;
  if (prefix.length > totalBytes) {
    throw new Error(
      `label "${label}" is too long to pad to ${totalBytes} bytes`
    );
  }
  return prefix + "a".repeat(totalBytes - prefix.length);
}

const TEST_SCHEMA = {
  incorporationRules: [{ objectType: "message", targetPath: "messages" }],
  paths: [
    { collection: "ordered", path: "messages" },
    { collection: "single", path: "context.manifest" },
  ],
  schemaId: "schema_postgres_unstorable_text",
} satisfies TurnTreeSchema;

interface CodedError {
  code?: string;
}

function readErrorCode(error: unknown): string | undefined {
  return (error as CodedError | undefined)?.code;
}

beforeAll(async () => {
  await assertDevenvPostgresReady();
});

afterAll(async () => {
  await cleanupAllocatedSchemas();
});

describe("@tuvren/backend-postgres NUL-identifier boundary validation", () => {
  test("rejects tx.objects.put's mediaType containing U+0000 with a typed error, not the raw engine error", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      const kernel = createRuntimeKernel({ backend });
      let caughtError: unknown;

      try {
        await kernel.store.put(
          new Uint8Array([1, 2, 3]),
          `text/plain${NUL}evil`
        );
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(readErrorCode(caughtError)).toBe(UNSTORABLE_TEXT_CODE);
      expect(readErrorCode(caughtError)).not.toBe(
        "postgres_backend_engine_error"
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("rejects tx.threads.put's threadId containing U+0000 with a typed error, not the raw engine error", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      const kernel = createRuntimeKernel({ backend });
      const schemaId = await kernel.schema.register(TEST_SCHEMA);
      // A real thread supplies a genuinely referenced schemaId/
      // rootTurnNodeHash, so the failing write below is exercised with
      // otherwise-valid foreign-key targets — only the threadId is bad.
      const seedThread = await kernel.thread.create(
        "thread_unstorable_text_seed",
        schemaId,
        "branch_unstorable_text_seed"
      );

      let caughtError: unknown;
      try {
        await backend.transact(async (tx) => {
          await tx.threads.put({
            createdAtMs: Date.now(),
            rootTurnNodeHash: seedThread.rootTurnNodeHash,
            schemaId,
            threadId: `thread_bad${NUL}id`,
          });
        });
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(readErrorCode(caughtError)).toBe(UNSTORABLE_TEXT_CODE);
      expect(readErrorCode(caughtError)).not.toBe(
        "postgres_backend_engine_error"
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("rejects tx.stagedResults.set's objectType containing U+0000 with a typed error, not the raw engine error", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      const kernel = createRuntimeKernel({ backend });
      // A real stored object supplies a well-formed objectHash so the failing
      // write below passes the record-shape guard — only objectType is bad.
      // The storable-text assertion fires before the run-existence check, so
      // no run needs to exist.
      const objectHash = await kernel.store.put(
        new Uint8Array([7, 8, 9]),
        "text/plain"
      );

      let caughtError: unknown;
      try {
        await backend.transact(async (tx) => {
          await tx.stagedResults.set({
            createdAtMs: Date.now(),
            objectHash,
            objectType: `message${NUL}evil`,
            runId: "run_unstorable_object_type",
            status: "completed",
            taskId: "task_unstorable_object_type",
          });
        });
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(readErrorCode(caughtError)).toBe(UNSTORABLE_TEXT_CODE);
      expect(readErrorCode(caughtError)).not.toBe(
        "postgres_backend_engine_error"
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("rejects tx.stagedResults.clearRun's runId containing U+0000 with a typed error, not the raw engine error", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      // clearRun issues a bare DELETE keyed on scope + runId with no other
      // record to validate first, so no seed state (kernel, schema, run) is
      // required to reach the storable-text check — only the runId argument
      // is bad.
      let caughtError: unknown;
      try {
        await backend.transact(async (tx) => {
          await tx.stagedResults.clearRun(`run_bad${NUL}id`);
        });
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(readErrorCode(caughtError)).toBe(UNSTORABLE_TEXT_CODE);
      expect(readErrorCode(caughtError)).not.toBe(
        "postgres_backend_engine_error"
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("still accepts ordinary NUL-free writes", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      const kernel = createRuntimeKernel({ backend });
      const hash = await kernel.store.put(
        new Uint8Array([4, 5, 6]),
        "text/plain"
      );
      expect(await kernel.store.has(hash)).toBe(true);

      const schemaId = await kernel.schema.register(TEST_SCHEMA);
      const thread = await kernel.thread.create(
        "thread_unstorable_text_ok",
        schemaId,
        "branch_unstorable_text_ok"
      );
      expect(await kernel.thread.get(thread.threadId)).not.toBeNull();
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});

describe("@tuvren/backend-postgres btree index-row-size boundary validation", () => {
  test("rejects tx.stagedResults.clearRun's runId exceeding the byte-length bound with a typed error, not the raw engine error", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      // Mirrors the reviewer's ~3.8KB devenv repro: an incompressible
      // over-bound identifier used to fail deep in the driver as
      // `ERROR: index row size ... exceeds btree version 4 maximum 2704`
      // (SQLSTATE 54000), surfacing as an untyped
      // `postgres_backend_engine_error`. clearRun needs no seed state, so
      // this reaches the storable-text check with nothing else to satisfy.
      const overLongRunId = "run_".padEnd(4000, "a");
      let caughtError: unknown;
      try {
        await backend.transact(async (tx) => {
          await tx.stagedResults.clearRun(overLongRunId);
        });
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(readErrorCode(caughtError)).toBe(TEXT_TOO_LONG_CODE);
      expect(readErrorCode(caughtError)).not.toBe(
        "postgres_backend_engine_error"
      );
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("still rejects a value just under the byte-length bound with an embedded NUL as unstorable text, not as too-long (ordering/precedence sanity)", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      // One byte under the bound overall (511 bytes), with a NUL folded in
      // partway through: short enough that the length check alone would let
      // it through, so this proves the NUL check still runs (and still
      // wins) ahead of the length check.
      const almostAtBoundWithNul = `${"a".repeat(255)}${NUL}${"a".repeat(255)}`;
      expect(Buffer.byteLength(almostAtBoundWithNul, "utf8")).toBeLessThan(
        MAX_STORABLE_TEXT_BYTES
      );

      let caughtError: unknown;
      try {
        await backend.transact(async (tx) => {
          await tx.stagedResults.clearRun(almostAtBoundWithNul);
        });
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(readErrorCode(caughtError)).toBe(UNSTORABLE_TEXT_CODE);
      expect(readErrorCode(caughtError)).not.toBe(TEXT_TOO_LONG_CODE);
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });

  test("inserts the worst real composite (observe_annotations record_key) with its unbounded field at exactly the byte-length bound", async () => {
    const options = createPostgresTestBackendOptions();
    const backend = createPostgresBackend(options);

    try {
      const kernel = createRuntimeKernel({ backend });
      const schemaId = await kernel.schema.register(TEST_SCHEMA);

      // thread_id, branch_id, and turn_id all sit at the same bound: they
      // are not the field under proof here, but keeping them at the bound
      // too means this single insert also exercises
      // idx_turns_scope_thread_branch_head_turn_node — the largest raw-byte
      // composite in the schema per MAX_STORABLE_TEXT_BYTES's docblock —
      // with real data instead of only the observe-annotation record_key.
      const threadId = asciiIdOfLength(
        "thread_at_bound",
        MAX_STORABLE_TEXT_BYTES
      );
      const branchId = asciiIdOfLength(
        "branch_at_bound",
        MAX_STORABLE_TEXT_BYTES
      );
      const turnId = asciiIdOfLength("turn_at_bound", MAX_STORABLE_TEXT_BYTES);
      const runId = asciiIdOfLength("run_at_bound", MAX_STORABLE_TEXT_BYTES);

      const thread = await kernel.thread.create(threadId, schemaId, branchId);
      const turn = await kernel.turn.create(
        turnId,
        threadId,
        branchId,
        null,
        thread.rootTurnNodeHash
      );
      await kernel.run.create(
        runId,
        turn.turnId,
        branchId,
        schemaId,
        thread.rootTurnNodeHash,
        [{ deterministic: true, id: "noop", sideEffects: false }]
      );

      const payload = { note: "worst-composite-observe-annotation" };
      const annotationHash = await hashKernelRecord(payload);
      const annotationCbor = encodeDeterministicKernelRecord(payload);
      const record: StoredObserveAnnotation = {
        annotationCbor,
        annotationHash,
        createdAtMs: Date.now(),
        runId,
        // Present (not null) so both fixed-length hash fields in
        // record_key are at their own maximum, matching the worst-case
        // arithmetic in MAX_STORABLE_TEXT_BYTES's docblock.
        turnNodeHash: thread.rootTurnNodeHash,
      };

      await backend.transact(async (tx) => {
        await tx.observeAnnotations.set(record);
      });

      const readBack = await backend.transact((tx) =>
        tx.observeAnnotations.listByRun(runId)
      );
      expect(readBack.length).toBe(1);
      expect(readBack[0]?.annotationHash).toBe(annotationHash);
      expect(readBack[0]?.turnNodeHash).toBe(thread.rootTurnNodeHash);
    } finally {
      await backend.destroy({ dropSchema: true });
    }
  });
});
