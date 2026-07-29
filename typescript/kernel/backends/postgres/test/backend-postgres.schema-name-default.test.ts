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

// Round-5 review P1 — `normalizeSchemaName` used to default an unset
// `schemaName` to `"public"`. Since this PR's relational rewrite (ADR-067)
// replaced the two well-namespaced blob-era tables with thirteen generic,
// unprefixed family tables (`objects`, `schemas`, `threads`, `branches`,
// `turns`, `runs`, `staged_results`, …) plus twenty-one `idx_*` indexes, a
// default-constructed backend pointed at `"public"` would either collide
// with an adopter's own identically named tables or silently colonize the
// adopter's default schema — and `destroyPostgresBackend` running `DROP
// SCHEMA IF EXISTS <schema> CASCADE` against that default would cascade-drop
// the adopter's entire public schema. This file is a pure unit test with no
// PostgreSQL dependency: it only exercises `normalizeSchemaName`'s pure
// string-in/string-out behavior.

import { describe, expect, test } from "bun:test";
import { normalizeSchemaName } from "../src/lib/postgres-backend-persistence.js";

describe("@tuvren/backend-postgres normalizeSchemaName default", () => {
  test('defaults an unset schemaName to the backend-owned "tuvren_kernel", not "public"', () => {
    expect(normalizeSchemaName(undefined)).toBe("tuvren_kernel");
  });

  test("passes an explicit schemaName through unchanged", () => {
    expect(normalizeSchemaName("host_owned_schema")).toBe("host_owned_schema");
  });

  test("still validates the backend-owned default against the schema-name pattern and length limit", () => {
    // Sanity check that the default is not special-cased past validation —
    // it is a plain string that must pass the same
    // `VALID_SCHEMA_NAME_PATTERN`/`MAX_SCHEMA_NAME_BYTES` checks an explicit
    // name would.
    expect(() => normalizeSchemaName("tuvren_kernel")).not.toThrow();
  });
});
