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

import { describe, expect, test } from "bun:test";
import { TuvrenPersistenceError } from "@tuvren/core";
import { createPostgresBackend } from "../src/index.js";

describe("@tuvren/backend-postgres connection error normalization", () => {
  test("transact wraps a forwarded DNS failure without labeling it as a PostgreSQL SQLSTATE", async () => {
    const backend = createPostgresBackend({
      database: "tuvren_runtime",
      host: "postgres-backend-unresolvable.invalid",
      port: 5432,
      schemaName: "test_network_error_normalization",
      username: "postgres",
    });

    try {
      let caughtError: unknown;
      try {
        await backend.transact(async () => undefined);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(TuvrenPersistenceError);
      if (!(caughtError instanceof TuvrenPersistenceError)) {
        throw new Error("expected a TuvrenPersistenceError");
      }

      expect(caughtError.code).toBe("postgres_backend_connection_error");
      expect(caughtError.details).toEqual({
        message: expect.any(String),
        networkCode: "ENOTFOUND",
      });
      expect(caughtError.details).not.toHaveProperty("postgresCode");
    } finally {
      await backend.close();
    }
  });
});
