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
import type { TuvrenStreamEvent } from "@tuvren/event-stream";
import { assertTuvrenStreamEvent } from "@tuvren/event-stream";

export interface FrameworkStreamTestFixtureSet {
  completedTurn: readonly TuvrenStreamEvent[];
  failedTurn: readonly TuvrenStreamEvent[];
  pausedTurn: readonly TuvrenStreamEvent[];
}

const FIXTURE_PATH_SEGMENTS = ["conformance", "fixtures", "stream-events.json"];

export const frameworkStreamTestFixtures: FrameworkStreamTestFixtureSet =
  loadFrameworkStreamFixtures();

function loadFrameworkStreamFixtures(): FrameworkStreamTestFixtureSet {
  const fixtureText = readFileSync(resolveFixturePath(import.meta.url), "utf8");
  const parsedFixture = JSON.parse(fixtureText);
  assertFrameworkStreamTestFixtureSet(parsedFixture);
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

  throw new Error("unable to locate framework conformance fixture file");
}

function assertFrameworkStreamTestFixtureSet(
  value: unknown
): asserts value is FrameworkStreamTestFixtureSet {
  if (!isRecord(value)) {
    throw new Error("framework conformance fixture set must be an object");
  }

  assertTuvrenStreamEventArray(value.completedTurn, "completedTurn");
  assertTuvrenStreamEventArray(value.failedTurn, "failedTurn");
  assertTuvrenStreamEventArray(value.pausedTurn, "pausedTurn");
}

function assertTuvrenStreamEventArray(
  value: unknown,
  label: string
): asserts value is readonly TuvrenStreamEvent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  for (const [index, event] of value.entries()) {
    assertTuvrenStreamEvent(event, `${label}[${index}]`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
