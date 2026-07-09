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

import { rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, mock, test } from "node:test";
import type { normalizeBackendError as NormalizeBackendError } from "../src/lib/sqlite-errors.js";

/**
 * KRT-BK009 structural regression guard: the shape/cause assertions in
 * `backend-sqlite.rollback-normalization.test.ts` cannot distinguish a single
 * `normalizeBackendError` call on the `transact` rollback path from a double
 * call, because `normalizeBackendError` is idempotent -- calling it twice
 * produces the exact same object as calling it once. This file pins the
 * actual structural invariant with a call-count spy: it fails if
 * `SqliteBackend.transact`'s catch block is ever changed to normalize more
 * than once (the old nested try/catch bug this ticket collapsed).
 *
 * This spy relies on `node:test`'s `mock.module`, which requires the
 * `--experimental-test-module-mocks` flag (wired into this package's `test`
 * Nx target) and can only intercept a module specifier that has not already
 * been linked anywhere in this process. Every workspace import in this file
 * is therefore performed with a *dynamic* `import()` inside the test body,
 * after `mock.module` is registered -- never as a static top-level import --
 * so nothing pre-links `../src/lib/sqlite-errors.js` (directly or via
 * `../src/index.js` / `./backend-sqlite-test-helpers.js`) ahead of the mock.
 * Do not add a static workspace import to this file without re-verifying the
 * spy still intercepts; it will silently stop working otherwise.
 */
describe("@tuvren/backend-sqlite transact rollback normalization call-count guard (KRT-BK009)", () => {
  test("invokes normalizeBackendError exactly once on the transact rollback path", async () => {
    const sqliteErrorsUrl = new URL(
      "../src/lib/sqlite-errors.js",
      import.meta.url
    ).href;

    const real = (await import(sqliteErrorsUrl)) as {
      getErrorMessage: (error: unknown) => string;
      normalizeBackendError: typeof NormalizeBackendError;
      persistenceError: (
        message: string,
        code: string,
        details?: unknown,
        cause?: unknown
      ) => Error;
    };

    let callCount = 0;
    const mockContext = mock.module(sqliteErrorsUrl, {
      namedExports: {
        getErrorMessage: real.getErrorMessage,
        normalizeBackendError: (error: unknown) => {
          callCount += 1;
          return real.normalizeBackendError(error);
        },
        persistenceError: real.persistenceError,
      },
    });

    const tempDirectory = mkdtempSync(
      join(tmpdir(), "backend-sqlite-rollback-guard-")
    );

    try {
      const { createSqliteBackend } = (await import(
        "../src/index.js"
      )) as typeof import("../src/index.js");

      const databasePath = join(tempDirectory, "kraken.db");
      const backend = createSqliteBackend({ databasePath });

      try {
        await rejects(
          backend.transact(() => {
            // Any thrown error during the transaction's work exercises the
            // rollback path in `transact`'s catch block -- the exact shape of
            // the error is irrelevant to this guard, which only counts calls.
            throw new Error(
              "rollback-normalization-guard: forced work failure"
            );
          })
        );

        strictEqual(
          callCount,
          1,
          `expected normalizeBackendError to be invoked exactly once on the rollback path, saw ${callCount} calls`
        );
      } finally {
        await backend.close();
      }
    } finally {
      mockContext.restore();
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
