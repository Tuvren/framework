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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TurnTreeSchema } from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createPostgresBackend } from "../src/index.js";
import {
  assertDevenvPostgresReady,
  cleanupAllocatedSchemas,
  createPostgresTestBackendOptions,
} from "./postgres-test-helpers.js";

const NUL = "\u0000";
const UNSTORABLE_TEXT_CODE = "postgres_backend_unstorable_text";

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
