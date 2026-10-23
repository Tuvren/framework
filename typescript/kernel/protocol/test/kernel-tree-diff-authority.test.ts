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
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const read = (file: string): string =>
  readFileSync(path.join(ROOT, file), "utf-8");
const ORDERING =
  "changedPaths contain no duplicates and are in ascending unsigned UTF-8 byte order of the path.";

describe("tree.diff authority and release coverage", () => {
  test("states the canonical ordering in the specification and authority packet", () => {
    expect(read("docs/KrakenKernelSpecification.md")).toContain(ORDERING);
    expect(read("spec/kernel/authority-packet.json")).toContain(ORDERING);
  });

  test("ships a patch changeset for every affected public kernel package", () => {
    const [, frontMatter] = read(
      ".changeset/certification-db-kernel-protocol.md"
    ).split("---");
    expect(typeof frontMatter).toBe("string");
    if (frontMatter === undefined) {
      throw new Error("missing changeset front matter");
    }
    const releases: unknown = parse(frontMatter);
    expect(releases).toEqual({
      "@tuvren/kernel-protocol": "patch",
      "@tuvren/kernel-runtime": "patch",
    });
  });
});
