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

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

interface AuthorityPacketManifest {
  authoritativeSources: Array<{
    format: string;
    path: string;
  }>;
  bindingAppendices?: Array<{
    language: string;
    path: string;
  }>;
  bindingProjections?: Record<string, string>;
  conformancePlans?: Array<{
    path: string;
    planId: string;
    planVersion: string;
  }>;
  forbiddenAuthoritySources: string[];
  freshnessChecks?: Array<{
    artifact: string;
    regenerateCommand: string;
  }>;
  generatedArtifacts?: Array<{
    generatedFrom: string;
    generator?: string;
    path: string;
  }>;
  packetId: string;
  verificationPaths: Array<{
    kind: string;
    target: string;
  }>;
  version: string;
}

interface ConformancePlanDocument {
  packetId: string;
  planId: string;
  planVersion: string;
}

interface ValidationFailure {
  manifestPath: string;
  message: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const SCHEMA_PATH = resolve(
  REPO_ROOT,
  "tools/schemas/authority-packet.schema.json"
);
const MANIFEST_FILE_NAME = "authority-packet.json";

await main();

async function main(): Promise<void> {
  const failures = await validateAuthorityPackets();

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${relative(REPO_ROOT, failure.manifestPath)}: ${failure.message}`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("authority packet validation passed");
}

export async function validateAuthorityPackets(): Promise<ValidationFailure[]> {
  const manifestPaths = await findAuthorityPacketManifests(BOUNDARIES_ROOT);
  const schema = readJsonSchema(
    JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as unknown,
    SCHEMA_PATH
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const failures: ValidationFailure[] = [];
  const seenPacketIds = new Map<string, string>();

  for (const manifestPath of manifestPaths) {
    const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;

    if (!validate(value)) {
      failures.push({
        manifestPath,
        message: `schema validation failed: ${ajv.errorsText(validate.errors)}`,
      });
      continue;
    }

    const manifest = value as AuthorityPacketManifest;
    const priorPacketPath = seenPacketIds.get(manifest.packetId);

    if (priorPacketPath === undefined) {
      seenPacketIds.set(manifest.packetId, manifestPath);
    } else {
      failures.push({
        manifestPath,
        message: `duplicates packetId ${manifest.packetId} already declared by ${relative(
          REPO_ROOT,
          priorPacketPath
        )}`,
      });
    }

    validateManifestPaths(manifestPath, manifest, failures);
    validateForbiddenSources(manifestPath, manifest, failures);
    validateGeneratedArtifacts(manifestPath, manifest, failures);
    await validateConformancePlanLinks(manifestPath, manifest, failures);
    validateVerificationPaths(manifestPath, manifest, failures);
  }

  return failures;
}

async function findAuthorityPacketManifests(
  directory: string
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      manifests.push(...(await findAuthorityPacketManifests(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name === MANIFEST_FILE_NAME) {
      manifests.push(entryPath);
    }
  }

  return manifests.sort();
}

function validateManifestPaths(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  failures: ValidationFailure[]
): void {
  for (const source of manifest.authoritativeSources) {
    requireExistingPath(manifestPath, source.path, failures, "source");
  }

  for (const artifact of manifest.generatedArtifacts ?? []) {
    requireExistingPath(manifestPath, artifact.path, failures, "artifact");
    requireExistingPath(
      manifestPath,
      artifact.generatedFrom,
      failures,
      "generatedFrom"
    );
  }

  for (const plan of manifest.conformancePlans ?? []) {
    requireExistingPath(manifestPath, plan.path, failures, "conformance plan");
  }

  for (const appendix of manifest.bindingAppendices ?? []) {
    requireExistingPath(
      manifestPath,
      appendix.path,
      failures,
      "binding appendix"
    );
  }

  for (const [language, projectionPath] of Object.entries(
    manifest.bindingProjections ?? {}
  )) {
    requireExistingPath(
      manifestPath,
      projectionPath,
      failures,
      `${language} binding projection`
    );
  }
}

function validateForbiddenSources(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  failures: ValidationFailure[]
): void {
  const forbiddenSources = new Set(manifest.forbiddenAuthoritySources);

  for (const projectionPath of Object.values(
    manifest.bindingProjections ?? {}
  )) {
    if (!forbiddenSources.has(projectionPath)) {
      failures.push({
        manifestPath,
        message: `binding projection ${projectionPath} must also appear in forbiddenAuthoritySources`,
      });
    }
  }
}

function validateGeneratedArtifacts(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  failures: ValidationFailure[]
): void {
  const freshnessChecks = new Map(
    (manifest.freshnessChecks ?? []).map((check) => [check.artifact, check])
  );
  const generatedArtifacts = new Set(
    (manifest.generatedArtifacts ?? []).map((artifact) => artifact.path)
  );

  for (const artifact of manifest.generatedArtifacts ?? []) {
    const check = freshnessChecks.get(artifact.path);

    if (check === undefined) {
      failures.push({
        manifestPath,
        message: `generated artifact ${artifact.path} lacks a freshnessChecks entry`,
      });
      continue;
    }

    if (check.regenerateCommand.trim().length === 0) {
      failures.push({
        manifestPath,
        message: `freshness check for ${artifact.path} lacks a regenerate command`,
      });
    }
  }

  for (const check of manifest.freshnessChecks ?? []) {
    if (!generatedArtifacts.has(check.artifact)) {
      failures.push({
        manifestPath,
        message: `freshness check ${check.artifact} does not match a generatedArtifacts entry`,
      });
    }
  }
}

async function validateConformancePlanLinks(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  failures: ValidationFailure[]
): Promise<void> {
  const declaredPlans = new Map(
    (manifest.conformancePlans ?? []).map((plan) => [plan.path, plan])
  );
  const authorityPlanSources = manifest.authoritativeSources.filter(
    (source) => source.format === "conformance-plan"
  );

  for (const source of authorityPlanSources) {
    if (!declaredPlans.has(source.path)) {
      failures.push({
        manifestPath,
        message: `authoritative conformance plan ${source.path} must also appear in conformancePlans`,
      });
    }
  }

  for (const plan of manifest.conformancePlans ?? []) {
    const sourcePath = resolve(REPO_ROOT, plan.path);

    if (!existsSync(sourcePath)) {
      continue;
    }

    const value = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;

    if (!isConformancePlanDocument(value)) {
      failures.push({
        manifestPath,
        message: `conformance plan ${plan.path} is missing packetId, planId, or planVersion`,
      });
      continue;
    }

    if (value.packetId !== manifest.packetId) {
      failures.push({
        manifestPath,
        message: `conformance plan ${plan.path} packetId ${value.packetId} does not match ${manifest.packetId}`,
      });
    }

    if (
      value.planId !== plan.planId ||
      value.planVersion !== plan.planVersion
    ) {
      failures.push({
        manifestPath,
        message: `conformance plan ${plan.path} metadata does not match manifest declaration`,
      });
    }
  }
}

function validateVerificationPaths(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  failures: ValidationFailure[]
): void {
  const hasExecutableVerification = manifest.verificationPaths.some(
    (verificationPath) =>
      verificationPath.kind === "schema-validation" ||
      verificationPath.kind === "conformance-plan"
  );

  if (!(hasExecutableVerification || manifest.version.startsWith("0.0."))) {
    failures.push({
      manifestPath,
      message:
        "packets without schema-validation or conformance-plan verification must use a 0.0.x version",
    });
  }

  for (const verificationPath of manifest.verificationPaths) {
    requireExistingPath(
      manifestPath,
      verificationPath.target,
      failures,
      `${verificationPath.kind} verification target`
    );
  }

  const conformanceVerificationTargets = new Set(
    manifest.verificationPaths
      .filter(
        (verificationPath) => verificationPath.kind === "conformance-plan"
      )
      .map((verificationPath) => verificationPath.target)
  );

  for (const plan of manifest.conformancePlans ?? []) {
    if (!conformanceVerificationTargets.has(plan.path)) {
      failures.push({
        manifestPath,
        message: `conformance plan ${plan.path} is not listed as an executable verification path`,
      });
    }
  }
}

function requireExistingPath(
  manifestPath: string,
  candidatePath: string,
  failures: ValidationFailure[],
  label: string
): void {
  const absolutePath = resolve(REPO_ROOT, candidatePath);

  if (!existsSync(absolutePath)) {
    failures.push({
      manifestPath,
      message: `declared ${label} does not exist: ${candidatePath}`,
    });
  }
}

function readJsonSchema(value: unknown, label: string): AnySchema {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConformancePlanDocument(
  value: unknown
): value is ConformancePlanDocument {
  return (
    isRecord(value) &&
    typeof value.packetId === "string" &&
    typeof value.planId === "string" &&
    typeof value.planVersion === "string"
  );
}
