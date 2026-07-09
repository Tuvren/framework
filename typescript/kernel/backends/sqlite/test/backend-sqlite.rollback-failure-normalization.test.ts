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

import { ok, rejects } from "node:assert/strict";
import { describe, test } from "node:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import { createSqliteBackend } from "../src/index.js";
import {
  createTempDatabasePath,
  NORMALIZED_ENGINE_ERROR_PATTERN,
} from "./backend-sqlite-test-helpers.js";

/**
 * KRT-BK009: collapsing `transact`'s nested try/catch into one left a gap --
 * if `this.db.exec("ROLLBACK")` itself throws while handling a work-function
 * failure, that rollback error used to propagate to the (removed) outer catch,
 * which still normalized it. After the collapse it escaped completely
 * unnormalized. This test forces a genuine failure in the ROLLBACK statement
 * itself (not the transaction's work) and asserts the escaping error is still
 * normalized.
 *
 * The failure is injected deterministically by overriding the backend's own
 * better-sqlite3 handle so exactly the `"ROLLBACK"` statement throws, while
 * every other statement (`BEGIN IMMEDIATE`, the work's real writes, etc.) is
 * delegated to the real implementation unchanged. This exercises the real
 * `SqliteBackend.transact` control flow end-to-end without corrupting the
 * database or relying on a flaky OS/engine-level fault (disk full, WAL
 * corruption) that cannot be triggered deterministically in a unit test. The
 * simulated failure carries a `SQLITE_`-prefixed `code`, matching the shape a
 * genuine better-sqlite3 rollback failure would have, so it exercises
 * `normalizeBackendError`'s real engine-error wrapping branch instead of its
 * pass-through branch for uncoded errors.
 */

const SIMULATED_ROLLBACK_FAILURE_PATTERN = /simulated rollback failure/u;

describe("@tuvren/backend-sqlite transact rollback-failure normalization (KRT-BK009)", () => {
  test("normalizes an error thrown by ROLLBACK itself instead of letting it escape unnormalized", async () => {
    const databasePath = createTempDatabasePath();
    const backend = createSqliteBackend({ databasePath });

    const internal = backend as unknown as {
      db: { exec: (sql: string) => unknown };
    };
    const originalExec = internal.db.exec.bind(internal.db);
    internal.db.exec = (sql: string) => {
      if (sql === "ROLLBACK") {
        const rollbackFailure = new Error(
          "simulated rollback failure (KRT-BK009 test)"
        ) as Error & { code: string };
        rollbackFailure.code = "SQLITE_ERROR";
        throw rollbackFailure;
      }
      return originalExec(sql);
    };

    try {
      await rejects(
        backend.transact(() => {
          throw new Error(
            "work failure that triggers the rollback attempt above"
          );
        }),
        (error: unknown) => {
          // The rollback failure supersedes the original work error: the
          // escaping error is the normalized ROLLBACK failure (matching the
          // old, pre-collapse nested-catch behavior), not an unnormalized raw
          // throw and not the work error.
          ok(error instanceof TuvrenPersistenceError);
          ok(NORMALIZED_ENGINE_ERROR_PATTERN.test(error.message));
          const { cause } = error;
          ok(cause instanceof Error);
          ok(SIMULATED_ROLLBACK_FAILURE_PATTERN.test(cause.message));
          return true;
        }
      );
    } finally {
      internal.db.exec = originalExec;
      await backend.close();
    }
  });
});
