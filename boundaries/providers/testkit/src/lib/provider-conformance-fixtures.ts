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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TuvrenModelResponse, TuvrenPrompt } from "@tuvren/provider-api";
import { assertTuvrenModelResponse } from "@tuvren/provider-api";

export interface ProviderTestkitFixtureSet {
  prompt: TuvrenPrompt;
  response: TuvrenModelResponse;
  structuredPrompt: TuvrenPrompt;
  toolPrompt: TuvrenPrompt;
}

const FIXTURE_PATH_SEGMENTS = [
  "conformance",
  "fixtures",
  "provider-fixtures.json",
];

export const providerTestkitFixtures: ProviderTestkitFixtureSet =
  loadProviderTestkitFixtures();

function loadProviderTestkitFixtures(): ProviderTestkitFixtureSet {
  const fixtureText = readFileSync(resolveFixturePath(import.meta.url), "utf8");
  const parsedFixture = JSON.parse(fixtureText);
  assertProviderTestkitFixtureSet(parsedFixture);
  return parsedFixture;
}

function resolveFixturePath(metaUrl: string): string {
  const currentFilePath = fileURLToPath(metaUrl);
  let currentDirectory = dirname(currentFilePath);

  for (let index = 0; index < 8; index += 1) {
    const candidatePath = join(currentDirectory, ...FIXTURE_PATH_SEGMENTS);

    if (existsSync(candidatePath)) {
      return candidatePath;
    }

    currentDirectory = dirname(currentDirectory);
  }

  throw new Error("unable to locate provider conformance fixture file");
}

function assertProviderTestkitFixtureSet(
  value: unknown
): asserts value is ProviderTestkitFixtureSet {
  if (!isRecord(value)) {
    throw new Error("provider conformance fixture set must be an object");
  }

  assertTuvrenPrompt(value.prompt, "prompt");
  assertTuvrenModelResponse(value.response, "response");
  assertTuvrenPrompt(value.structuredPrompt, "structuredPrompt");
  assertTuvrenPrompt(value.toolPrompt, "toolPrompt");
}

function assertTuvrenPrompt(
  value: unknown,
  label: string
): asserts value is TuvrenPrompt {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new Error(`${label}.messages must be a non-empty array`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
