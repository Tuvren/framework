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
    resolvedArtifact?: string;
    resolvedKeyPath?: string;
    target: string;
  }>;
  version: string;
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
const SPEC_ROOT = resolve(REPO_ROOT, "spec");
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
  // No existsSync guard on the root: a missing spec/ (sparse checkout,
  // wrong cwd) must fail this gate loudly, never pass it vacuously.
  const manifestPaths = (await findAuthorityPacketManifests(SPEC_ROOT)).sort();
  if (manifestPaths.length === 0) {
    throw new Error(
      `vocabulary gate found zero authority packets under ${SPEC_ROOT} — refusing to report a vacuous pass`
    );
  }
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
        vocabularyPath,
        failures
      );
    }
  }

  return failures;
}

async function validateVocabularyTarget(
  manifestPath: string,
  manifest: AuthorityPacketManifest,
  verificationPath: AuthorityPacketManifest["verificationPaths"][number],
  failures: ValidationFailure[]
): Promise<void> {
  const vocabularyTargetPath = verificationPath.target;
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
      message: `vocabulary-check target ${vocabularyTargetPath} must be a Weaver semconv document — accepted shapes are a top-level "groups" sequence (definition/1) or a top-level "attribute_groups" / "attributes" / "metrics" / "events" / "resources" section (definition/2)`,
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

  if (verificationPath.resolvedArtifact === undefined) {
    failures.push({
      manifestPath,
      message: `vocabulary-check verificationPaths entry for ${vocabularyTargetPath} must declare resolvedArtifact (path to the Weaver-resolved registry JSON) so the validator does not hardcode any specific filename`,
    });
    return;
  }

  if (verificationPath.resolvedKeyPath === undefined) {
    failures.push({
      manifestPath,
      message: `vocabulary-check verificationPaths entry for ${vocabularyTargetPath} must declare resolvedKeyPath (dot path with "*" array iteration, e.g. "attributes.*.key") so the validator does not hardcode any one resolved-registry shape`,
    });
    return;
  }

  const resolvedArtifactPath = verificationPath.resolvedArtifact;
  const declaredAsGenerated = (manifest.generatedArtifacts ?? []).some(
    (artifact) => artifact.path === resolvedArtifactPath
  );

  if (!declaredAsGenerated) {
    failures.push({
      manifestPath,
      message: `vocabulary-check resolvedArtifact ${resolvedArtifactPath} must also appear under the packet's generatedArtifacts so its freshness is governed by the same packet`,
    });
    return;
  }

  const absoluteArtifactPath = resolve(REPO_ROOT, resolvedArtifactPath);

  if (!existsSync(absoluteArtifactPath)) {
    failures.push({
      manifestPath,
      message: `vocabulary-check resolved artifact does not exist: ${resolvedArtifactPath}`,
    });
    return;
  }

  const rawArtifact = JSON.parse(
    await readFile(absoluteArtifactPath, "utf8")
  ) as unknown;
  const extractionResult = extractResolvedKeys(
    rawArtifact,
    verificationPath.resolvedKeyPath
  );

  if (extractionResult.error !== undefined) {
    failures.push({
      manifestPath,
      message: `vocabulary-check resolved artifact ${resolvedArtifactPath} does not match resolvedKeyPath ${verificationPath.resolvedKeyPath}: ${extractionResult.error}`,
    });
    return;
  }

  const resolvedKeys = extractionResult.keys;

  // The resolved artifact is a registry whose identifier list lives at the
  // manifest-declared `resolvedKeyPath`. Its values must match attribute ids
  // declared in the source YAML — group ids are NOT valid resolved keys.
  // Accepting group ids here would widen the validator in the exact direction
  // it should reject: a Weaver regression that emits a group name as a
  // registry key has to fail.
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

interface ResolvedKeyExtraction {
  error?: string;
  keys: Set<string>;
}

function extractResolvedKeys(
  artifact: unknown,
  keyPath: string
): ResolvedKeyExtraction {
  // `resolvedKeyPath` is a dot-separated path with `*` as the array-iteration
  // wildcard. Examples:
  //   - `attributes.*.key`     → today's Weaver attribute registry
  //   - `metrics.*.name`       → a hypothetical metric registry
  //   - `attribute_groups.*.attributes.*.id` → nested registry shape
  // The walker is deliberately simple: it supports literal property segments,
  // single-level `*` iteration, and a final scalar-string leaf. Anything else
  // returns an `error` so the validator surfaces a tooling-friendly message
  // rather than silently accepting the wrong shape.
  const segments = keyPath.split(".");
  const keys = new Set<string>();
  const errors: string[] = [];
  walkResolvedKeyPath(artifact, segments, 0, keys, errors);

  if (errors.length > 0) {
    return { error: errors[0], keys };
  }

  if (keys.size === 0) {
    return {
      error: "resolvedKeyPath produced no identifier strings",
      keys,
    };
  }

  return { keys };
}

function walkResolvedKeyPath(
  value: unknown,
  segments: readonly string[],
  index: number,
  keys: Set<string>,
  errors: string[]
): void {
  if (index === segments.length) {
    if (typeof value !== "string") {
      errors.push(`expected a string at resolved leaf, got ${typeof value}`);
      return;
    }

    keys.add(value);
    return;
  }

  const segment = segments[index] ?? "";

  if (segment === "*") {
    if (!Array.isArray(value)) {
      errors.push(`expected an array at "*" segment ${index}`);
      return;
    }

    for (const entry of value) {
      walkResolvedKeyPath(entry, segments, index + 1, keys, errors);
    }

    return;
  }

  if (!isRecord(value)) {
    errors.push(
      `expected an object before segment "${segment}" at index ${index}`
    );
    return;
  }

  walkResolvedKeyPath(value[segment], segments, index + 1, keys, errors);
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
  // because of their dot depth. Two top-level shapes are accepted:
  //
  //   - definition/1 (today's `tuvren-runtime.yaml`): a top-level `groups:`
  //     sequence where each entry has `id`, `attributes`, optional
  //     `member_attributes`, optional `extends: <other-group-id>`.
  //   - definition/2 (Weaver's newer registry model): the file may instead
  //     publish top-level sections like `attributes:`, `attribute_groups:`,
  //     `metrics:`, `events:`, `resources:`. Each behaves like a group for
  //     this validator's purposes: a sequence of records that own attribute
  //     declarations either inline (`{id, type, ...}`), by reference
  //     (`{ref: "..."}`), or by group reference (`{ref_group: "..."}`).
  //
  // Group ids and attribute ids are unioned across whichever sections are
  // present; the `extends` and `ref_group` edges are resolved transitively
  // through `resolveGroupAttributes`.
  const parsed: unknown = yaml.parse(yamlContent);

  if (!isRecord(parsed)) {
    return undefined;
  }

  const rawGroups = new Map<string, RawGroup>();
  const groupIds = new Set<string>();

  const rawGroupSources = collectRawGroupSources(parsed);

  if (rawGroupSources.length === 0) {
    return undefined;
  }

  for (const groupEntry of rawGroupSources) {
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

  // definition/2 also allows attribute declarations directly at the top-level
  // `attributes:` sequence (no enclosing group). Treat each such entry as a
  // synthetic single-attribute group so it contributes to the vocabulary.
  collectAttributeIds(parsed.attributes, attributeIds, rawGroups, new Set());

  return { attributeIds, groupIds };
}

function collectRawGroupSources(parsed: Record<string, unknown>): unknown[] {
  // Both legacy and definition/2 shapes are unioned. Each contributes
  // group-like records to the raw group set; downstream resolution is
  // identical because the per-group fields we care about (`id`,
  // `attributes`, `member_attributes`, `extends`) line up across the two
  // model versions.
  const sections = [
    parsed.groups,
    parsed.attribute_groups,
    parsed.metrics,
    parsed.events,
    parsed.resources,
  ];
  const collected: unknown[] = [];

  for (const section of sections) {
    if (Array.isArray(section)) {
      collected.push(...section);
    }
  }

  return collected;
}

function resolveGroupAttributes(
  groupId: string,
  rawGroups: ReadonlyMap<string, RawGroup>,
  visited: Set<string>
): Set<string> {
  const ids = new Set<string>();

  if (visited.has(groupId)) {
    // Defensive: short-circuit on a cyclic `extends` / `ref_group` chain
    // rather than recursing forever. Weaver's schema forbids cycles, but we
    // don't trust the source enough to assume it.
    return ids;
  }

  visited.add(groupId);

  const raw = rawGroups.get(groupId);

  if (raw === undefined) {
    return ids;
  }

  collectAttributeIds(raw.attributes, ids, rawGroups, visited);
  collectAttributeIds(raw.memberAttributes, ids, rawGroups, visited);

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
  attributeIds: Set<string>,
  rawGroups: ReadonlyMap<string, RawGroup>,
  visited: Set<string>
): void {
  if (!Array.isArray(attributesValue)) {
    return;
  }

  for (const attribute of attributesValue) {
    if (!isRecord(attribute)) {
      continue;
    }

    // Weaver supports three declaration shapes inside a group's attribute
    // list:
    //   - `{ id: "attr.name", type: ..., ... }` declares an attribute
    //     inline.
    //   - `{ ref: "attr.name", ... }` reuses an attribute defined elsewhere
    //     (typically in a registry group).
    //   - `{ ref_group: "group.id", ... }` pulls in every attribute owned
    //     by another group by id (forward-compat: tuvren-runtime.yaml does
    //     not currently use this form, but Weaver's semconv schema does
    //     support it and a future revision could land it without warning).
    // All three forms contribute attribute ids to the effective vocabulary.
    if (typeof attribute.id === "string") {
      attributeIds.add(attribute.id);
      continue;
    }

    if (typeof attribute.ref === "string") {
      attributeIds.add(attribute.ref);
      continue;
    }

    if (typeof attribute.ref_group === "string") {
      // Resolve the named group's effective attribute set transitively
      // through the same recursion that handles `extends`, so a nested
      // `ref_group` chain or a `ref_group` that targets a group with its
      // own `extends` parent resolves correctly. The `visited` set is
      // shared with the caller so cyclic chains terminate.
      const inherited = resolveGroupAttributes(
        attribute.ref_group,
        rawGroups,
        visited
      );

      for (const id of inherited) {
        attributeIds.add(id);
      }
    }
  }
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
