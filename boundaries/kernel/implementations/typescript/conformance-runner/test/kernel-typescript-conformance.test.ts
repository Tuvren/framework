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
import {
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import {
  canonicalKernelTestSchemaFixture,
  type KernelProtocolDeterministicFixtureSet,
  type KernelProtocolLogicalFixtureSet,
  kernelProtocolDeterministicFixtures,
  kernelProtocolLogicalFixtures,
} from "../../../../testkit/src/lib/kernel-conformance-fixtures.ts";

const LOWERCASE_SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const KERNEL_SUITE_MANIFEST = new URL(
  "../../../../conformance/scenarios/suite-manifest.json",
  import.meta.url
);
const KERNEL_SUITE_MANIFEST_SCHEMA = new URL(
  "../../../../conformance/schemas/suite-manifest.schema.json",
  import.meta.url
);

describe("kernel TypeScript conformance runner", () => {
  test("executes the shared kernel protocol seed suite", async () => {
    const fixtures = readValidatedKernelFixtureSuite(KERNEL_SUITE_MANIFEST);

    // The implementation runner reads the boundary-owned files first; the
    // testkit exports are checked as a TypeScript convenience layer, not as
    // the source of semantic authority for compatibility reporting.
    expect(canonicalKernelTestSchemaFixture).toEqual(fixtures.canonicalSchema);
    expect(kernelProtocolDeterministicFixtures).toEqual(fixtures.deterministic);
    expect(kernelProtocolLogicalFixtures).toEqual(fixtures.logical);
    expect(canonicalKernelTestSchemaFixture.schemaId).toBe("schema_main");
    expect(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecordSha256Hex
    ).toMatch(LOWERCASE_SHA256_HEX_PATTERN);
    expect(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecordSha256Hex
    ).toMatch(LOWERCASE_SHA256_HEX_PATTERN);
    expect(kernelProtocolLogicalFixtures.recoveryState).toMatchObject({
      lastCompletedStepId: "tool_execution",
    });
    expect(kernelProtocolLogicalFixtures.turnTreeChangeSet).toHaveProperty(
      "messages"
    );
    expect(
      await hashOpaqueObjectBytes(
        Uint8Array.from(kernelProtocolDeterministicFixtures.rawOpaqueBytes)
      )
    ).toBe(kernelProtocolDeterministicFixtures.rawOpaqueBytesSha256Hex);
    expect(
      await hashKernelRecord(
        decodeDeterministicKernelRecord(
          hexToBytes(
            kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex
          )
        )
      )
    ).toBe(kernelProtocolDeterministicFixtures.turnTreeSchemaRecordSha256Hex);
    expect(
      await hashTurnNodeIdentity({
        consumedStagedResults: [
          ...kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
            .consumedStagedResults,
        ],
        eventHash:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord.eventHash,
        previousTurnNodeHash:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
            .previousTurnNodeHash,
        schemaId:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord.schemaId,
        turnTreeHash:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
            .turnTreeHash,
      })
    ).toBe(kernelProtocolDeterministicFixtures.turnNodeIdentityRecordSha256Hex);
  });
});

interface KernelFixtureSuite {
  canonicalSchema: TurnTreeSchema;
  deterministic: KernelProtocolDeterministicFixtureSet;
  logical: KernelProtocolLogicalFixtureSet;
}

interface SuiteFixture {
  id: string;
  path: string;
}

interface SuiteManifest {
  boundary: string;
  fixtureSchemaPath: string;
  fixtures: SuiteFixture[];
  suiteId: string;
  suiteVersion: string;
}

function readValidatedKernelFixtureSuite(manifestUrl: URL): KernelFixtureSuite {
  const manifest = readSuiteManifest(manifestUrl);
  const manifestSchema = readJsonSchema(
    fileURLToPath(KERNEL_SUITE_MANIFEST_SCHEMA)
  );
  const manifestAjv = new Ajv2020({ allErrors: true, strict: false });
  const validateManifest = manifestAjv.compile(manifestSchema);

  expect(
    validateManifest(readJsonObject(fileURLToPath(manifestUrl))),
    manifestAjv.errorsText(validateManifest.errors)
  ).toBe(true);
  expect(manifest).toMatchObject({
    boundary: "kernel",
    suiteId: "tuvren.kernel.protocol-seed",
    suiteVersion: "0.2.0",
  });
  expect(manifest.fixtures.map((fixture) => fixture.id)).toEqual([
    "canonical-turn-tree-schema",
    "kernel-protocol-deterministic",
    "kernel-protocol-logical",
  ]);

  const manifestDirectory = dirname(fileURLToPath(manifestUrl));
  const fixtureIndex = {
    canonicalSchemaPath: fixturePathById(
      manifest.fixtures,
      "canonical-turn-tree-schema"
    ),
    deterministicFixturePath: fixturePathById(
      manifest.fixtures,
      "kernel-protocol-deterministic"
    ),
    logicalFixturePath: fixturePathById(
      manifest.fixtures,
      "kernel-protocol-logical"
    ),
  };
  const schema = readJsonSchema(
    join(manifestDirectory, manifest.fixtureSchemaPath)
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  expect(validate(fixtureIndex), ajv.errorsText(validate.errors)).toBe(true);

  const canonicalSchemaPath = join(
    manifestDirectory,
    fixtureIndex.canonicalSchemaPath
  );
  const deterministicPath = join(
    manifestDirectory,
    fixtureIndex.deterministicFixturePath
  );
  const logicalPath = join(manifestDirectory, fixtureIndex.logicalFixturePath);
  const canonicalSchema = readJsonObject(canonicalSchemaPath);
  const deterministic = readJsonObject(deterministicPath);
  const logical = readJsonObject(logicalPath);

  assertTurnTreeSchema(canonicalSchema, canonicalSchemaPath);
  assertKernelProtocolDeterministicFixtureSet(deterministic, deterministicPath);
  assertKernelProtocolLogicalFixtureSet(logical, logicalPath);

  return {
    canonicalSchema,
    deterministic,
    logical,
  };
}

function readSuiteManifest(url: URL): SuiteManifest {
  const value = readJsonObject(fileURLToPath(url));

  if (
    typeof value.boundary !== "string" ||
    typeof value.fixtureSchemaPath !== "string" ||
    !Array.isArray(value.fixtures) ||
    typeof value.suiteId !== "string" ||
    typeof value.suiteVersion !== "string"
  ) {
    throw new Error(`${url.pathname} must be a valid suite manifest`);
  }

  const fixtures = value.fixtures.map((fixture) => {
    if (
      !isRecord(fixture) ||
      typeof fixture.id !== "string" ||
      typeof fixture.path !== "string"
    ) {
      throw new Error(`${url.pathname} must contain valid fixture entries`);
    }

    return {
      id: fixture.id,
      path: fixture.path,
    };
  });

  return {
    boundary: value.boundary,
    fixtureSchemaPath: value.fixtureSchemaPath,
    fixtures,
    suiteId: value.suiteId,
    suiteVersion: value.suiteVersion,
  };
}

function fixturePathById(
  fixtures: readonly SuiteFixture[],
  expectedId: string
): string {
  const fixture = fixtures.find((entry) => entry.id === expectedId);

  if (fixture === undefined) {
    throw new Error(`kernel suite is missing fixture ${expectedId}`);
  }

  return fixture.path;
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

function assertKernelProtocolDeterministicFixtureSet(
  value: unknown,
  label: string
): asserts value is KernelProtocolDeterministicFixtureSet {
  if (
    !(
      isRecord(value) &&
      Array.isArray(value.rawOpaqueBytes) &&
      typeof value.rawOpaqueBytesSha256Hex === "string" &&
      isRecord(value.turnNodeIdentityRecord) &&
      typeof value.turnNodeIdentityRecordCborHex === "string" &&
      typeof value.turnNodeIdentityRecordSha256Hex === "string" &&
      isRecord(value.turnTreeSchemaRecord) &&
      typeof value.turnTreeSchemaRecordCborHex === "string" &&
      typeof value.turnTreeSchemaRecordSha256Hex === "string"
    )
  ) {
    throw new Error(`${label} must contain deterministic kernel fixtures`);
  }
}

function assertKernelProtocolLogicalFixtureSet(
  value: unknown,
  label: string
): asserts value is KernelProtocolLogicalFixtureSet {
  if (
    !(
      isRecord(value) &&
      Array.isArray(value.branchHeadListEntry) &&
      isRecord(value.recoveryState) &&
      isRecord(value.turnTreeChangeSet)
    )
  ) {
    throw new Error(`${label} must contain logical kernel fixtures`);
  }
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{1,2}/gu)?.map((entry) => Number.parseInt(entry, 16)) ?? []
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
