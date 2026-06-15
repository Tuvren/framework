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
import { findSecretLeaks } from "../secret-absence/index.ts";

const SECRET = "tuvren-secretiso-mcp-bearer-3a1c5e7b9d2f4a6c8e0b1d3f5a7c9e1b";

describe("secret-absence scanner (KRT-BD004)", () => {
  test("reports no leak for a secret-free surface", () => {
    const surface = {
      events: [{ name: "tool", type: "tool.start" }],
      records: [{ message: "hello", role: "user" }],
    };
    expect(findSecretLeaks(surface, [SECRET])).toEqual([]);
  });

  test("detects a raw secret nested in the surface", () => {
    const surface = { records: [{ auth: { token: SECRET } }] };
    const findings = findSecretLeaks(surface, [SECRET]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.variant).toBe("raw");
  });

  test("detects each covered derived leak form", () => {
    // The leading label documents the derived leak form each surface exercises;
    // the scan only needs the surface, so the label is not bound in the loop.
    const cases: [string, unknown][] = [
      ["header-normalized", { v: SECRET.toUpperCase() }],
      ["bearer-prefixed", { authorization: `Bearer ${SECRET}` }],
      ["base64", { v: Buffer.from(SECRET, "utf8").toString("base64") }],
      ["base64url", { v: Buffer.from(SECRET, "utf8").toString("base64url") }],
      ["partial-token", { v: `prefix-${SECRET.slice(0, 24)}` }],
    ];
    for (const [, surface] of cases) {
      const findings = findSecretLeaks(surface, [SECRET]);
      expect(findings.length).toBeGreaterThan(0);
    }
  });

  test("detects a URL-encoded secret with special characters", () => {
    const special = "pg:pa ss/word@host";
    const surface = { dsn: encodeURIComponent(special) };
    const findings = findSecretLeaks(surface, [special]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.variant).toBe("url-encoded");
  });

  test("detects a secret embedded in raw Uint8Array bytes", () => {
    const surface = {
      record: new TextEncoder().encode(`prefix${SECRET}suffix`),
    };
    expect(findSecretLeaks(surface, [SECRET]).length).toBeGreaterThan(0);
  });

  test("scans multiple secrets and reports each leak independently", () => {
    const other = "sk-tuvren-secretiso-provider-7f3c9a1e2b4d6f8a";
    const surface = { a: SECRET, b: "clean" };
    const findings = findSecretLeaks(surface, [SECRET, other]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.secret).toBe(SECRET);
  });
});
