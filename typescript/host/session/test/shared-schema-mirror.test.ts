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
import { resolve } from "node:path";

/**
 * Drift guard for the hand-mirrored shared payload models.
 *
 * `spec/host/session/typespec/main.tsp` redeclares a subset of the
 * runtime-api models field-for-field (per the sub-surface self-containment
 * precedent) with "must stay in sync" doc notes. Doc notes alone cannot fail
 * a build, so this test compares the generated JSON Schema artifacts of the
 * two packets: if the runtime-api authority evolves and the session mirror
 * does not, the normalized schemas diverge and this test fails.
 *
 * Normalization strips the packet-specific `$id`/`$ref` base URLs and
 * `description` strings (doc comments legitimately differ); every structural
 * property — types, required arrays, patterns, minItems, allOf conditionals —
 * must be identical.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const RUNTIME_API_DIR = resolve(REPO_ROOT, "spec/host/artifacts/json-schema");
const SESSION_DIR = resolve(
  REPO_ROOT,
  "spec/host/session/artifacts/json-schema"
);

const MIRRORED_MODELS = [
  "NonEmptyString",
  "Metadata",
  "TextPart",
  "ReasoningPart",
  "ToolCallPart",
  "ToolResultPart",
  "FilePart",
  "StructuredPart",
  "ContentPart",
  "InputSignal",
  "ApprovalDecision",
  "ApprovalResponse",
] as const;

const PACKET_ID_BASE = /^https:\/\/tuvren\.dev\/schemas\/framework\/[a-z-]+\//;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "description") {
        continue;
      }
      if ((key === "$id" || key === "$ref") && typeof entry === "string") {
        out[key] = entry.replace(PACKET_ID_BASE, "");
        continue;
      }
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

function readNormalized(dir: string, model: string): unknown {
  return normalize(
    JSON.parse(readFileSync(resolve(dir, `${model}.json`), "utf8"))
  );
}

describe("session packet mirrors of runtime-api shared models", () => {
  for (const model of MIRRORED_MODELS) {
    test(`${model} matches the runtime-api authority structurally`, () => {
      expect(readNormalized(SESSION_DIR, model)).toEqual(
        readNormalized(RUNTIME_API_DIR, model)
      );
    });
  }
});
