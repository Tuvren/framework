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
import {
  decodeTurnTreePathRow,
  type PostgresTurnTreePathRow,
} from "../src/lib/postgres-records.js";

const BASE_ROW = {
  collection_kind: "single",
  ordered_chunk_list_cbor: null,
  ordered_count: null,
  ordered_encoding: null,
  ordered_inline_cbor: null,
  path: "messages",
  single_hash: "object-1",
  turn_tree_hash: "tree-1",
} satisfies PostgresTurnTreePathRow;

describe("@tuvren/backend-postgres turn-tree path row decoding", () => {
  test.each([
    {
      ...BASE_ROW,
      ordered_count: 1,
    },
    {
      ...BASE_ROW,
      collection_kind: "ordered" as const,
      ordered_count: 1,
      ordered_encoding: "flat" as const,
      ordered_inline_cbor: new Uint8Array([
        0x81, 0x68, 0x6f, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x2d, 0x31,
      ]),
    },
    {
      ...BASE_ROW,
      collection_kind: "ordered" as const,
      ordered_chunk_list_cbor: new Uint8Array([0x80]),
      ordered_count: 0,
      ordered_encoding: "chunked" as const,
      ordered_inline_cbor: new Uint8Array([0x80]),
      single_hash: null,
    },
  ] satisfies PostgresTurnTreePathRow[])("rejects contradictory active and inactive variant columns", (row) => {
    let caughtError: unknown;
    try {
      decodeTurnTreePathRow(row);
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(TuvrenPersistenceError);
    if (!(caughtError instanceof TuvrenPersistenceError)) {
      throw new Error("expected a TuvrenPersistenceError");
    }
    expect(caughtError.code).toBe(
      "postgres_backend_invalid_turn_tree_path_row"
    );
  });
});
