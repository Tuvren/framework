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

interface AuthorityPacketManifest {
  authoritativeSources: Array<{
    format: string;
    path: string;
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

interface ResolvedAttributeArtifact {
  attributes: Array<{ key: string }>;
}

interface ValidationFailure {
  manifestPath: string;
  message: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const MANIFEST_FILE_NAME = "authority-packet.json";
const ATTRIBUTE_ID_PATTERN = /^\s*-\s*id:\s*([A-Za-z][A-Za-z0-9._-]*)\s*$/gmu;
const SEMCONV_YAML_FORMAT = "semconv-yaml";

await main();

async function main(): Promise<void> {
  const failures = await validateVocabularies();

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${relative(REPO_ROOT, failure.manifestPath)}: ${failure.message}`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("vocabulary-check verification passed");
}

async function validateVocabularies(): Promise<ValidationFailure[]> {
  const manifestPaths = await findAuthorityPacketManifests(BOUNDARIES_ROOT);
  const failures: ValidationFailure[] = [];

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as AuthorityPacketManifest;

    const vocabularyPaths = manifest.verificationPaths.filter(
      (verificationPath) => verificationPath.kind === "vocabulary-check"
    );

    if (vocabularyPaths.length === 0) {
      continue;
    }

    for (const vocabularyPath of vocabularyPaths) {
      await validateVocabularyTarget(
        manifestPath,
        manifest,
        vocabularyPath.target,
        failures
      );
    }
  }

  return failures;
}

async function validateVocabularyTarget(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  vocabularyTargetPath: string,
  failures: ValidationFailure[]
): Promise<void> {
  const absoluteTargetPath = resolve(REPO_ROOT, vocabularyTargetPath);

  if (!existsSync(absoluteTargetPath)) {
    failures.push({
      manifestPath,
      message: `vocabulary-check target does not exist: ${vocabularyTargetPath}`,
    });
    return;
  }

  if (
    !(
      vocabularyTargetPath.endsWith(".yaml") ||
      vocabularyTargetPath.endsWith(".yml")
    )
  ) {
    failures.push({
      manifestPath,
      message: `vocabulary-check target must be a YAML file: ${vocabularyTargetPath}`,
    });
    return;
  }

  const isDeclaredSemconvYaml = manifest.authoritativeSources.some(
    (source) =>
      source.path === vocabularyTargetPath &&
      source.format === SEMCONV_YAML_FORMAT
  );

  if (!isDeclaredSemconvYaml) {
    failures.push({
      manifestPath,
      message: `vocabulary-check target ${vocabularyTargetPath} must be declared as an authoritative source with format "${SEMCONV_YAML_FORMAT}"`,
    });
    return;
  }

  const vocabularyContent = await readFile(absoluteTargetPath, "utf8");
  const declaredIdentifiers = extractIdentifiers(vocabularyContent);

  if (declaredIdentifiers.size === 0) {
    failures.push({
      manifestPath,
      message: `vocabulary-check target ${vocabularyTargetPath} declares no identifiers`,
    });
    return;
  }

  const resolvedArtifact = findResolvedAttributesArtifact(manifest);

  if (resolvedArtifact === undefined) {
    failures.push({
      manifestPath,
      message: `vocabulary-check requires a generatedArtifacts entry whose path ends in "otel-attributes.json"; none found`,
    });
    return;
  }

  const absoluteArtifactPath = resolve(REPO_ROOT, resolvedArtifact);

  if (!existsSync(absoluteArtifactPath)) {
    failures.push({
      manifestPath,
      message: `vocabulary-check resolved artifact does not exist: ${resolvedArtifact}`,
    });
    return;
  }

  const rawArtifact = JSON.parse(
    await readFile(absoluteArtifactPath, "utf8")
  ) as unknown;

  if (!isResolvedAttributeArtifact(rawArtifact)) {
    failures.push({
      manifestPath,
      message: `vocabulary-check resolved artifact ${resolvedArtifact} must have the shape {attributes: [{key: string, ...}]}`,
    });
    return;
  }

  const resolvedKeys = new Set(
    rawArtifact.attributes.map((attribute) => attribute.key)
  );

  const orphanedKeys = [...resolvedKeys].filter(
    (key) => !declaredIdentifiers.has(key)
  );

  if (orphanedKeys.length > 0) {
    failures.push({
      manifestPath,
      message: `vocabulary-check: resolved artifact has keys that are not declared in ${vocabularyTargetPath}: ${orphanedKeys.sort().join(", ")}`,
    });
  }

  const undeclaredYamlAttributeIds = filterYamlAttributeIdentifiers(
    declaredIdentifiers
  ).filter((id) => !resolvedKeys.has(id));

  if (undeclaredYamlAttributeIds.length > 0) {
    failures.push({
      manifestPath,
      message: `vocabulary-check: ${vocabularyTargetPath} declares attribute identifiers missing from the resolved artifact: ${undeclaredYamlAttributeIds.sort().join(", ")}`,
    });
  }
}

function extractIdentifiers(yamlContent: string): Set<string> {
  const identifiers = new Set<string>();

  for (const match of yamlContent.matchAll(ATTRIBUTE_ID_PATTERN)) {
    const identifier = match[1];

    if (identifier !== undefined) {
      identifiers.add(identifier);
    }
  }

  return identifiers;
}

function filterYamlAttributeIdentifiers(identifiers: Set<string>): string[] {
  // Attribute identifiers carry at least three dot-separated segments
  // (e.g., tuvren.runtime.run.id). Group identifiers are shorter
  // (e.g., tuvren.runtime.identity). The semconv conventions guarantee
  // attribute keys exceed the group depth, so dot count is a reliable
  // discriminator inside a single vocabulary.
  return [...identifiers].filter((identifier) => {
    const dotCount = identifier.split(".").length - 1;

    return dotCount >= 3;
  });
}

function findResolvedAttributesArtifact(
  manifest: AuthorityPacketManifest
): string | undefined {
  for (const artifact of manifest.generatedArtifacts ?? []) {
    if (artifact.path.endsWith("otel-attributes.json")) {
      return artifact.path;
    }
  }

  return undefined;
}

function isResolvedAttributeArtifact(
  value: unknown
): value is ResolvedAttributeArtifact {
  if (!isRecord(value)) {
    return false;
  }

  if (!Array.isArray(value.attributes)) {
    return false;
  }

  return value.attributes.every(
    (attribute) => isRecord(attribute) && typeof attribute.key === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
