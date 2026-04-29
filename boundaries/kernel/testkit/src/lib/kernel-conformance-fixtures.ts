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
import {
  assertRecoveryState,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  type RecoveryState,
  type StagedResult,
  type TurnTreeChangeSet,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

export interface KernelProtocolDeterministicFixtureSet {
  rawOpaqueBytes: number[];
  rawOpaqueBytesSha256Hex: string;
  turnNodeIdentityRecord: {
    consumedStagedResults: StagedResult[];
    eventHash: string;
    previousTurnNodeHash: string | null;
    schemaId: string;
    turnTreeHash: string;
  };
  turnNodeIdentityRecordCborHex: string;
  turnNodeIdentityRecordSha256Hex: string;
  turnTreeSchemaRecord: TurnTreeSchema;
  turnTreeSchemaRecordCborHex: string;
  turnTreeSchemaRecordSha256Hex: string;
}

export interface KernelProtocolLogicalFixtureSet {
  branchHeadListEntry: [string, string];
  recoveryState: RecoveryState;
  turnTreeChangeSet: TurnTreeChangeSet;
}

const CANONICAL_SCHEMA_PATH_SEGMENTS = [
  "conformance",
  "fixtures",
  "canonical-turn-tree-schema.json",
];
const DETERMINISTIC_FIXTURE_PATH_SEGMENTS = [
  "conformance",
  "fixtures",
  "kernel-protocol-deterministic.json",
];
const LOGICAL_FIXTURE_PATH_SEGMENTS = [
  "conformance",
  "fixtures",
  "kernel-protocol-logical.json",
];
const MANIFEST_PATH_SEGMENTS = [
  "conformance",
  "scenarios",
  "suite-manifest.json",
];
const LOWERCASE_HEX_PATTERN = /^[0-9a-f]+$/u;
const ajv = new Ajv2020({ allErrors: true, strict: false });

export const canonicalKernelTestSchemaFixture: TurnTreeSchema =
  loadCanonicalKernelTestSchema();
export const kernelProtocolDeterministicFixtures: KernelProtocolDeterministicFixtureSet =
  loadKernelProtocolDeterministicFixtures();
export const kernelProtocolLogicalFixtures: KernelProtocolLogicalFixtureSet =
  loadKernelProtocolLogicalFixtures();

function loadCanonicalKernelTestSchema(): TurnTreeSchema {
  const manifestPath = resolveFixturePath(
    import.meta.url,
    MANIFEST_PATH_SEGMENTS
  );
  assertKernelFixtureIndexSchema(manifestPath);
  const fixtureText = readFileSync(
    resolveFixturePath(import.meta.url, CANONICAL_SCHEMA_PATH_SEGMENTS),
    "utf8"
  );
  const parsedFixture = JSON.parse(fixtureText);
  assertTurnTreeSchema(parsedFixture, "canonicalKernelTestSchemaFixture");
  return parsedFixture;
}

function loadKernelProtocolDeterministicFixtures(): KernelProtocolDeterministicFixtureSet {
  const fixtureText = readFileSync(
    resolveFixturePath(import.meta.url, DETERMINISTIC_FIXTURE_PATH_SEGMENTS),
    "utf8"
  );
  const parsedFixture = JSON.parse(fixtureText);
  assertKernelProtocolDeterministicFixtureSet(parsedFixture);
  return parsedFixture;
}

function loadKernelProtocolLogicalFixtures(): KernelProtocolLogicalFixtureSet {
  const fixtureText = readFileSync(
    resolveFixturePath(import.meta.url, LOGICAL_FIXTURE_PATH_SEGMENTS),
    "utf8"
  );
  const parsedFixture = JSON.parse(fixtureText);
  assertKernelProtocolLogicalFixtureSet(parsedFixture);
  return parsedFixture;
}

function resolveFixturePath(
  metaUrl: string,
  pathSegments: readonly string[]
): string {
  const currentFilePath = fileURLToPath(metaUrl);
  let currentDirectory = dirname(currentFilePath);

  for (let index = 0; index < 8; index += 1) {
    const candidatePath = join(currentDirectory, ...pathSegments);

    if (existsSync(candidatePath)) {
      return candidatePath;
    }

    currentDirectory = dirname(currentDirectory);
  }

  throw new Error(
    `unable to locate kernel conformance fixture ${pathSegments.join("/")}`
  );
}

function assertKernelFixtureIndexSchema(manifestPath: string): void {
  const manifestText = readFileSync(manifestPath, "utf8");
  const parsedManifest = JSON.parse(manifestText);

  if (
    !isRecord(parsedManifest) ||
    typeof parsedManifest.fixtureSchemaPath !== "string" ||
    !Array.isArray(parsedManifest.fixtures)
  ) {
    throw new Error("kernel conformance manifest is invalid");
  }

  const fixtureIndex = readKernelFixtureIndex(parsedManifest.fixtures);
  const schemaPath = join(
    dirname(manifestPath),
    parsedManifest.fixtureSchemaPath
  );
  const schemaText = readFileSync(schemaPath, "utf8");
  const parsedSchema = readJsonSchema(JSON.parse(schemaText));
  const validate = ajv.compile(parsedSchema);

  // The kernel suite spans multiple seed files, so the manifest-declared JSON
  // Schema validates the fixture index while the typed assertions below guard
  // each decoded payload in detail.
  if (validate(fixtureIndex)) {
    return;
  }

  throw new Error(
    `kernel conformance fixture index failed JSON Schema validation: ${ajv.errorsText(validate.errors)}`
  );
}

function readJsonSchema(value: unknown): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error("kernel conformance schema must be an object or boolean");
}

function readKernelFixtureIndex(fixtures: readonly unknown[]): {
  canonicalSchemaPath: string;
  deterministicFixturePath: string;
  logicalFixturePath: string;
} {
  const pathById = new Map<string, string>();

  for (const fixture of fixtures) {
    if (
      !isRecord(fixture) ||
      typeof fixture.id !== "string" ||
      typeof fixture.path !== "string"
    ) {
      throw new Error("kernel conformance manifest fixture entry is invalid");
    }

    pathById.set(fixture.id, fixture.path);
  }

  const canonicalSchemaPath = pathById.get("canonical-turn-tree-schema");
  const deterministicFixturePath = pathById.get(
    "kernel-protocol-deterministic"
  );
  const logicalFixturePath = pathById.get("kernel-protocol-logical");

  if (
    canonicalSchemaPath === undefined ||
    deterministicFixturePath === undefined ||
    logicalFixturePath === undefined
  ) {
    throw new Error("kernel conformance manifest is missing required fixtures");
  }

  return {
    canonicalSchemaPath,
    deterministicFixturePath,
    logicalFixturePath,
  };
}

function assertKernelProtocolDeterministicFixtureSet(
  value: unknown
): asserts value is KernelProtocolDeterministicFixtureSet {
  if (!isRecord(value)) {
    throw new Error("kernel deterministic fixture set must be an object");
  }

  assertNumberArray(value.rawOpaqueBytes, "rawOpaqueBytes");
  assertHashString(value.rawOpaqueBytesSha256Hex, "rawOpaqueBytesSha256Hex");
  assertTurnTreeSchema(value.turnTreeSchemaRecord, "turnTreeSchemaRecord");
  assertHexString(
    value.turnTreeSchemaRecordCborHex,
    "turnTreeSchemaRecordCborHex"
  );
  assertHashString(
    value.turnTreeSchemaRecordSha256Hex,
    "turnTreeSchemaRecordSha256Hex"
  );
  assertTurnNodeIdentityRecord(
    value.turnNodeIdentityRecord,
    "turnNodeIdentityRecord"
  );
  assertHexString(
    value.turnNodeIdentityRecordCborHex,
    "turnNodeIdentityRecordCborHex"
  );
  assertHashString(
    value.turnNodeIdentityRecordSha256Hex,
    "turnNodeIdentityRecordSha256Hex"
  );
}

function assertKernelProtocolLogicalFixtureSet(
  value: unknown
): asserts value is KernelProtocolLogicalFixtureSet {
  if (!isRecord(value)) {
    throw new Error("kernel logical fixture set must be an object");
  }

  if (
    !Array.isArray(value.branchHeadListEntry) ||
    value.branchHeadListEntry.length !== 2
  ) {
    throw new Error("branchHeadListEntry must be a two-item tuple");
  }

  const [branchId, turnNodeHash] = value.branchHeadListEntry;

  if (typeof branchId !== "string") {
    throw new Error("branchHeadListEntry[0] must be a string");
  }

  assertHashString(turnNodeHash, "branchHeadListEntry[1]");
  assertRecoveryState(value.recoveryState, "recoveryState");
  assertTurnTreeChangeSet(
    value.turnTreeChangeSet,
    canonicalKernelTestSchemaFixture,
    "turnTreeChangeSet"
  );
}

function assertTurnNodeIdentityRecord(
  value: unknown,
  label: string
): asserts value is KernelProtocolDeterministicFixtureSet["turnNodeIdentityRecord"] {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (!Array.isArray(value.consumedStagedResults)) {
    throw new Error(`${label}.consumedStagedResults must be an array`);
  }

  if (typeof value.eventHash !== "string") {
    throw new Error(`${label}.eventHash must be a string`);
  }

  if (
    value.previousTurnNodeHash !== null &&
    typeof value.previousTurnNodeHash !== "string"
  ) {
    throw new Error(`${label}.previousTurnNodeHash must be a string or null`);
  }

  if (typeof value.schemaId !== "string") {
    throw new Error(`${label}.schemaId must be a string`);
  }

  if (typeof value.turnTreeHash !== "string") {
    throw new Error(`${label}.turnTreeHash must be a string`);
  }
}

function assertNumberArray(
  value: unknown,
  label: string
): asserts value is readonly number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "number") {
      throw new Error(`${label}[${index}] must be a number`);
    }
  }
}

function assertHexString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (!LOWERCASE_HEX_PATTERN.test(value)) {
    throw new Error(`${label} must be lowercase hexadecimal`);
  }
}

function assertHashString(
  value: unknown,
  label: string
): asserts value is string {
  assertHexString(value, label);

  if (value.length !== 64) {
    throw new Error(
      `${label} must be a 64-character lowercase hexadecimal hash`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
