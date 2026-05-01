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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type FrameworkStreamTestFixtureSet,
  frameworkStreamTestFixtures,
} from "../../../../testkit/src/index.ts";

const FRAMEWORK_SUITE_MANIFEST = new URL(
  "../../../../conformance/scenarios/suite-manifest.json",
  import.meta.url
);
const FRAMEWORK_SUITE_MANIFEST_SCHEMA = new URL(
  "../../../../conformance/schemas/suite-manifest.schema.json",
  import.meta.url
);

describe("framework TypeScript conformance runner", () => {
  test("executes the shared framework stream-event suite", () => {
    const fixture = readValidatedSingleFixtureSuite(
      FRAMEWORK_SUITE_MANIFEST,
      "stream-events"
    );

    // The TypeScript testkit remains a helper facade. The runner anchors its
    // evidence in the boundary-owned fixture file and only compares the helper
    // export to prove this implementation line is consuming the shared corpus.
    expect(frameworkStreamTestFixtures).toEqual(fixture);
    expect(
      fixture.completedTurn.map((event: { type: string }) => event.type)
    ).toEqual([
      "turn.start",
      "iteration.start",
      "message.start",
      "text.delta",
      "text.done",
      "tool_call.start",
      "tool_call.args_delta",
      "tool_call.done",
      "tool.start",
      "tool.result",
      "state.snapshot",
      "custom",
      "message.done",
      "iteration.end",
      "turn.end",
    ]);
    expect(fixture.completedTurn[6]).toMatchObject({
      callId: "call-search",
      delta: '{"query":"docs"}',
      type: "tool_call.args_delta",
    });
    expect(fixture.completedTurn[10]).toMatchObject({
      manifest: {
        byRole: {
          assistant: 1,
          system: 0,
          tool: 1,
          user: 1,
        },
        messageCount: 3,
        toolCalls: {
          byName: {
            search: 1,
          },
          total: 1,
        },
      },
      type: "state.snapshot",
    });
    expect(fixture.failedTurn.at(-1)).toMatchObject({
      status: "failed",
      type: "turn.end",
    });
    expect(fixture.pausedTurn[1]).toMatchObject({
      request: {
        toolCalls: [
          {
            callId: "call-email",
            decisions: ["approve", "reject"],
            name: "send_email",
          },
        ],
      },
      type: "approval.requested",
    });
    expect(fixture.pausedTurn.at(-1)).toMatchObject({
      status: "paused",
      type: "turn.end",
    });
  });
});

function readValidatedSingleFixtureSuite(
  manifestUrl: URL,
  expectedFixtureId: string
): FrameworkStreamTestFixtureSet {
  const manifest = readSuiteManifest(manifestUrl);
  const manifestSchema = readJsonSchema(
    fileURLToPath(FRAMEWORK_SUITE_MANIFEST_SCHEMA)
  );
  const manifestAjv = new Ajv2020({ allErrors: true, strict: false });
  const validateManifest = manifestAjv.compile(manifestSchema);

  expect(
    validateManifest(readJsonObject(fileURLToPath(manifestUrl))),
    manifestAjv.errorsText(validateManifest.errors)
  ).toBe(true);
  expect(manifest).toMatchObject({
    boundary: "framework",
    suiteId: "tuvren.framework.stream-events",
    suiteVersion: "0.2.0",
  });
  expect(manifest.fixtures).toEqual([
    {
      id: expectedFixtureId,
      path: "../fixtures/stream-events.json",
    },
  ]);

  const manifestDirectory = dirname(fileURLToPath(manifestUrl));
  const schema = readJsonSchema(
    join(manifestDirectory, manifest.fixtureSchemaPath)
  );
  const fixturePath = join(manifestDirectory, manifest.fixtures[0].path);
  const fixture = readJsonObject(fixturePath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  expect(validate(fixture), ajv.errorsText(validate.errors)).toBe(true);
  assertFrameworkStreamTestFixtureSet(fixture, fixturePath);
  return fixture;
}

interface SuiteFixture {
  id: string;
  path: string;
}

interface SuiteManifest {
  boundary: string;
  fixtureSchemaPath: string;
  fixtures: [SuiteFixture];
  suiteId: string;
  suiteVersion: string;
}

function readSuiteManifest(url: URL): SuiteManifest {
  const value = readJsonObject(fileURLToPath(url));

  if (
    typeof value.boundary !== "string" ||
    typeof value.fixtureSchemaPath !== "string" ||
    !Array.isArray(value.fixtures) ||
    value.fixtures.length !== 1 ||
    typeof value.suiteId !== "string" ||
    typeof value.suiteVersion !== "string"
  ) {
    throw new Error(`${url.pathname} must be a valid suite manifest`);
  }

  const fixture = value.fixtures[0];

  if (
    !isRecord(fixture) ||
    typeof fixture.id !== "string" ||
    typeof fixture.path !== "string"
  ) {
    throw new Error(`${url.pathname} must contain valid fixture entries`);
  }

  return {
    boundary: value.boundary,
    fixtureSchemaPath: value.fixtureSchemaPath,
    fixtures: [{ id: fixture.id, path: fixture.path }],
    suiteId: value.suiteId,
    suiteVersion: value.suiteVersion,
  };
}

function assertFrameworkStreamTestFixtureSet(
  value: unknown,
  label: string
): asserts value is FrameworkStreamTestFixtureSet {
  if (
    !(
      isRecord(value) &&
      Array.isArray(value.completedTurn) &&
      Array.isArray(value.failedTurn) &&
      Array.isArray(value.pausedTurn)
    )
  ) {
    throw new Error(`${label} must contain framework stream fixture arrays`);
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (!isRecord(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }

  return value;
}

function readJsonSchema(path: string): AnySchema {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${path} must contain a JSON Schema object or boolean`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
