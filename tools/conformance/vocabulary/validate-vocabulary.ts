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
import yaml from "yaml";

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

interface ExtractedSemconvVocabulary {
  attributeIds: Set<string>;
  groupIds: Set<string>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOUNDARIES_ROOT = resolve(REPO_ROOT, "boundaries");
const MANIFEST_FILE_NAME = "authority-packet.json";
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
  const extraction = extractSemconvVocabulary(vocabularyContent);

  if (extraction === undefined) {
    failures.push({
      manifestPath,
      message: `vocabulary-check target ${vocabularyTargetPath} must be a Weaver semconv document with a top-level "groups" sequence`,
    });
    return;
  }

  if (extraction.attributeIds.size === 0) {
    failures.push({
      manifestPath,
      message: `vocabulary-check target ${vocabularyTargetPath} declares no attribute identifiers`,
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

  // The resolved artifact is an attribute registry (`otel-attributes.json`),
  // so its keys must match attribute ids declared in the source YAML —
  // group ids are NOT valid resolved keys. Accepting group ids here would
  // widen the validator in the exact direction it should reject: a Weaver
  // regression that emits a group name as a registry key has to fail.
  const orphanedKeys = [...resolvedKeys].filter(
    (key) => !extraction.attributeIds.has(key)
  );

  if (orphanedKeys.length > 0) {
    failures.push({
      manifestPath,
      message: `vocabulary-check: resolved artifact has keys that are not declared as attribute ids in ${vocabularyTargetPath}: ${orphanedKeys.sort().join(", ")}`,
    });
  }

  const undeclaredYamlAttributeIds = [...extraction.attributeIds].filter(
    (id) => !resolvedKeys.has(id)
  );

  if (undeclaredYamlAttributeIds.length > 0) {
    failures.push({
      manifestPath,
      message: `vocabulary-check: ${vocabularyTargetPath} declares attribute identifiers missing from the resolved artifact: ${undeclaredYamlAttributeIds.sort().join(", ")}`,
    });
  }
}

interface RawGroup {
  attributes: unknown;
  extendsId: string | undefined;
  id: string | undefined;
  memberAttributes: unknown;
}

function extractSemconvVocabulary(
  yamlContent: string
): ExtractedSemconvVocabulary | undefined {
  // Parse the YAML structurally rather than line-scanning for `- id:` so that
  // deeply namespaced group ids (e.g. Weaver's `attributes.http.client.authority`
  // style) are still recognized as groups, not misclassified as attributes
  // because of their dot depth. The Weaver semconv schema places attribute ids
  // strictly under `groups[*].attributes[*].id` (or `attribute.ref` for
  // attributes reused from a registry group); group ids live at `groups[*].id`.
  // Groups may also declare `extends: <other-group-id>` to inherit the parent
  // group's attributes, so we resolve that edge transitively before producing
  // the effective per-group attribute set.
  const parsed: unknown = yaml.parse(yamlContent);

  if (!(isRecord(parsed) && Array.isArray(parsed.groups))) {
    return undefined;
  }

  const rawGroups = new Map<string, RawGroup>();
  const groupIds = new Set<string>();

  for (const groupEntry of parsed.groups) {
    if (!isRecord(groupEntry)) {
      continue;
    }

    if (typeof groupEntry.id !== "string") {
      continue;
    }

    groupIds.add(groupEntry.id);
    rawGroups.set(groupEntry.id, {
      attributes: groupEntry.attributes,
      extendsId:
        typeof groupEntry.extends === "string" ? groupEntry.extends : undefined,
      id: groupEntry.id,
      memberAttributes: groupEntry.member_attributes,
    });
  }

  const resolvedAttributesByGroup = new Map<string, Set<string>>();

  for (const groupId of rawGroups.keys()) {
    resolvedAttributesByGroup.set(
      groupId,
      resolveGroupAttributes(groupId, rawGroups, new Set())
    );
  }

  const attributeIds = new Set<string>();

  for (const groupAttributes of resolvedAttributesByGroup.values()) {
    for (const id of groupAttributes) {
      attributeIds.add(id);
    }
  }

  return { attributeIds, groupIds };
}

function resolveGroupAttributes(
  groupId: string,
  rawGroups: ReadonlyMap<string, RawGroup>,
  visited: Set<string>
): Set<string> {
  const ids = new Set<string>();

  if (visited.has(groupId)) {
    // Defensive: short-circuit on a cyclic `extends` chain rather than
    // recursing forever. Weaver's schema forbids cycles, but we don't trust
    // the source enough to assume it.
    return ids;
  }

  visited.add(groupId);

  const raw = rawGroups.get(groupId);

  if (raw === undefined) {
    return ids;
  }

  collectAttributeIds(raw.attributes, ids);
  collectAttributeIds(raw.memberAttributes, ids);

  if (raw.extendsId !== undefined) {
    const inherited = resolveGroupAttributes(raw.extendsId, rawGroups, visited);

    for (const id of inherited) {
      ids.add(id);
    }
  }

  return ids;
}

function collectAttributeIds(
  attributesValue: unknown,
  attributeIds: Set<string>
): void {
  if (!Array.isArray(attributesValue)) {
    return;
  }

  for (const attribute of attributesValue) {
    if (!isRecord(attribute)) {
      continue;
    }

    // Weaver supports two declaration shapes inside a group's attribute list:
    //   - `{ id: "attr.name", type: ..., ... }` declares an attribute inline.
    //   - `{ ref: "attr.name", ... }` reuses an attribute defined elsewhere
    //     (typically in a registry group). Both forms contribute the same
    //     attribute id to the effective vocabulary.
    if (typeof attribute.id === "string") {
      attributeIds.add(attribute.id);
    } else if (typeof attribute.ref === "string") {
      attributeIds.add(attribute.ref);
    }
  }
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
