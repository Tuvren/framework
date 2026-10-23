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

import { createMemoryBackend } from "@tuvren/backend-memory";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";

describe("tree.diff canonical changedPaths", () => {
  test("returns unique paths in unsigned UTF-8 order across BMP and supplementary characters", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const paths = [
      "\u{10000}",
      "\uE000",
      "aa",
      "z",
      "a",
      "\u{10FFFF}",
      "\uFFFF",
      "\u00E9",
      "e\u0301",
      "\u007F",
      "\u0080",
    ];
    const schemaId = await kernel.schema.register({
      incorporationRules: [],
      paths: [...paths, "unchanged"].map((path) => ({
        collection: "single",
        path,
      })),
      schemaId: "schema_utf8_diff",
    });
    const before = await kernel.tree.create(
      schemaId,
      Object.fromEntries([...paths, "unchanged"].map((path) => [path, null]))
    );
    const objectHash = await kernel.store.put(new Uint8Array([1]));
    const after = await kernel.tree.create(
      schemaId,
      Object.fromEntries(paths.map((path) => [path, objectHash])),
      before
    );
    const expected = [
      "a",
      "aa",
      "e\u0301",
      "z",
      "\u007F",
      "\u0080",
      "\u00E9",
      "\uE000",
      "\uFFFF",
      "\u{10000}",
      "\u{10FFFF}",
    ];

    expect(await kernel.tree.diff(before, after)).toEqual(expected);
    expect(await kernel.tree.diff(after, before)).toEqual(expected);
    expect(await kernel.tree.diff(before, after)).toEqual(expected);
    expect(await kernel.tree.diff(after, after)).toEqual([]);
  });
});
