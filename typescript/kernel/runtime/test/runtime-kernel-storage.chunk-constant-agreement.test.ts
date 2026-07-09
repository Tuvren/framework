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

// ADR-011 frames the ordered-path chunking threshold/size as an
// implementation constant, not a protocol constant, so each storage-owning
// module declares its own copy rather than importing a shared one (see
// runtime-kernel-storage.ts's RUNTIME_ORDERED_PATH_CHUNK_THRESHOLD /
// RUNTIME_ORDERED_PATH_CHUNK_SIZE comment). Since the constant is never
// exported anywhere, agreement can't be verified via a runtime import — this
// is a same-repo source-text invariant guard, not a cross-implementation
// conformance-plan check, so it deliberately lives here as a plain test
// rather than under tools/conformance/.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));

const DECLARATION_SOURCES = [
  join(TEST_DIRECTORY, "../src/lib/runtime-kernel-storage.ts"),
  join(
    TEST_DIRECTORY,
    "../../backends/memory/src/lib/memory-backend-turn-tree.ts"
  ),
  join(
    TEST_DIRECTORY,
    "../../backends/postgres/src/lib/memory-backend-turn-tree.ts"
  ),
  join(TEST_DIRECTORY, "../../backends/sqlite/src/lib/sqlite-backend.ts"),
  join(
    TEST_DIRECTORY,
    "../../backends/sqlite/src/lib/sqlite-integrity-assertions.ts"
  ),
];

function extractDeclaredValues(constantName: string): Array<{
  file: string;
  value: number;
}> {
  const pattern = new RegExp(`${constantName}\\s*=\\s*(\\d+)`, "g");
  const found: Array<{ file: string; value: number }> = [];

  for (const file of DECLARATION_SOURCES) {
    const text = readFileSync(file, "utf8");

    for (const match of text.matchAll(pattern)) {
      const rawValue = match[1];

      if (rawValue === undefined) {
        continue;
      }

      found.push({ file, value: Number.parseInt(rawValue, 10) });
    }
  }

  return found;
}

describe("ORDERED_PATH_CHUNK_THRESHOLD/SIZE cross-module agreement", () => {
  test("every ORDERED_PATH_CHUNK_THRESHOLD declaration across all 5 modules agrees", () => {
    const declarations = extractDeclaredValues("ORDERED_PATH_CHUNK_THRESHOLD");

    // sqlite-integrity-assertions.ts intentionally declares only the size
    // constant (per ADR-011's per-module framing), so the threshold is
    // expected in the other 4 files.
    expect(declarations.length).toBe(4);

    const [first, ...rest] = declarations;
    expect(first).toBeDefined();

    for (const declaration of rest) {
      expect(declaration.value).toBe((first as { value: number }).value);
    }
  });

  test("every ORDERED_PATH_CHUNK_SIZE declaration across all 5 modules agrees", () => {
    const declarations = extractDeclaredValues("ORDERED_PATH_CHUNK_SIZE");

    expect(declarations.length).toBe(5);

    const [first, ...rest] = declarations;
    expect(first).toBeDefined();

    for (const declaration of rest) {
      expect(declaration.value).toBe((first as { value: number }).value);
    }
  });

  test("ORDERED_PATH_CHUNK_THRESHOLD and ORDERED_PATH_CHUNK_SIZE agree with each other everywhere they coexist", () => {
    const thresholds = extractDeclaredValues("ORDERED_PATH_CHUNK_THRESHOLD");
    const sizes = extractDeclaredValues("ORDERED_PATH_CHUNK_SIZE");

    for (const threshold of thresholds) {
      const size = sizes.find((entry) => entry.file === threshold.file);
      expect(size).toBeDefined();
      expect(threshold.value).toBe((size as { value: number }).value);
    }
  });
});
