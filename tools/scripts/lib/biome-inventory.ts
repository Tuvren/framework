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

// KRT-BP008 / ADR-0070. The retained Biome gate must know the complete set of
// former-root files without running Biome's retained lint over the whole
// repository: after a directory migrates to OXC, a whole-root `biome lint .`
// would re-lint the migrated paths and hide discovery failures behind a
// successful exit. This module derives that inventory from owned state only:
//
//   1. Git's own index and ignore handling enumerate the working-tree files
//      that are tracked or untracked-but-not-ignored (`git ls-files`), and a
//      native `git ls-files --deleted` enumeration subtracts tracked paths
//      deleted from the working tree so migration never breaks on a stale
//      index entry.
//   2. Biome's `files.includes` include/ignore patterns -- resolved through
//      `extends` from the owned biome.jsonc and the pinned ultracite preset --
//      subtract Biome's own exclusions.
//   3. The supported language extensions keep exactly the JSON/JSONC/JS/TS
//      surface the retained lint policy owns.
//
// Nothing here executes Biome, so a migrated path never receives retained lint
// during discovery, and every failure (command, config, glob) is fatal.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Read-only Git enumeration of tracked plus untracked non-ignored files. */
export const FORMER_ROOT_DISCOVERY_COMMAND = [
  "git",
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
] as const;

// `--cached` still lists tracked paths deleted from the working tree, so a
// native Git enumeration of confirmed deletions lets discovery drop them
// without an `existsSync` probe that would also swallow permission and I/O
// failures. Subtracting Git's own answer keeps discovery fail-closed on any
// real filesystem error while never feeding Biome a missing path.
export const FORMER_ROOT_DELETED_COMMAND = [
  "git",
  "ls-files",
  "-z",
  "--deleted",
] as const;

// Biome's lint surface for this repository is the JS/TS and JSON/JSONC family.
// Unknown or non-source types are not part of the retained policy.
const SUPPORTED_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const LEADING_BANGS_PATTERN = /^!+/;

interface GlobMatcher {
  match(value: string): boolean;
}

interface GlobConstructor {
  new (pattern: string): GlobMatcher;
}

interface JsoncParser {
  parse(text: string): unknown;
}

interface BunRuntime {
  Glob: GlobConstructor;
  JSONC: JsoncParser;
}

interface BiomeConfigDocument {
  extends?: unknown;
  files?: { includes?: unknown };
}

const bun = (globalThis as unknown as { Bun: BunRuntime }).Bun;

/** Decompose NUL-delimited `git ls-files -z` stdout into repo-relative paths. */
export function parseGitFileList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Drop tracked paths Git confirms are deleted from the working tree. The two
 * sets come from separate `git ls-files` enumerations, so discovery never
 * trusts the working tree itself and a permission or I/O failure stays fatal
 * instead of being misread as a deletion.
 */
export function removeDeletedFiles(
  candidates: readonly string[],
  deleted: readonly string[]
): string[] {
  if (deleted.length === 0) {
    return [...candidates];
  }
  const deletedPaths = new Set(deleted);
  return candidates.filter((file) => !deletedPaths.has(file));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, source: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${source}: expected a string array`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${source}: every entry must be a string`);
    }
    out.push(entry);
  }
  return out;
}

function parseBiomeConfig(text: string, source: string): BiomeConfigDocument {
  const parsed = bun.JSONC.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const files = parsed.files;
  if (files !== undefined && !isRecord(files)) {
    throw new Error(`${source}: "files" must be an object`);
  }
  return {
    extends: parsed.extends,
    files: { includes: files?.includes },
  };
}

function resolveExtends(entry: string, configPath: string): string {
  if (entry.startsWith(".")) {
    return path.resolve(path.dirname(configPath), entry);
  }
  return createRequire(configPath).resolve(entry);
}

function collectIncludes(
  configPath: string,
  seen: Set<string>,
  out: string[]
): void {
  if (seen.has(configPath)) {
    return;
  }
  seen.add(configPath);
  let parsed: BiomeConfigDocument;
  try {
    parsed = parseBiomeConfig(readFileSync(configPath, "utf8"), configPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read Biome config ${configPath}: ${detail}`);
  }
  for (const entry of stringArray(parsed.extends, `${configPath}.extends`)) {
    collectIncludes(resolveExtends(entry, configPath), seen, out);
  }
  out.push(
    ...stringArray(parsed.files?.includes, `${configPath}.files.includes`)
  );
}

/**
 * Every `files.includes` pattern the retained Biome config resolves to, from
 * the owned configuration through each `extends` level.
 */
export function readBiomeIncludes(configPath: string): string[] {
  const out: string[] = [];
  collectIncludes(configPath, new Set<string>(), out);
  return out;
}

function normalizePattern(pattern: string): string {
  return pattern.replace(LEADING_BANGS_PATTERN, "");
}

function matchesPattern(matcher: GlobMatcher, file: string): boolean {
  if (matcher.match(file)) {
    return true;
  }
  // A directory pattern such as `!!**/generated` excludes every file beneath
  // an ancestor directory with that name, not only a file of that name.
  const segments = file.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    if (matcher.match(segments.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
}

function isSupportedSourceFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot > 0 && SUPPORTED_EXTENSIONS.has(file.slice(dot));
}

/**
 * Filter candidate working-tree paths down to the complete former-root Biome
 * inventory: supported source types that match the owned `files.includes`
 * surface and no owned exclusion.
 */
export function selectFormerRootFiles(
  repoRoot: string,
  candidates: readonly string[]
): string[] {
  const includes = readBiomeIncludes(path.join(repoRoot, "biome.jsonc"));
  const matcherCache = new Map<string, GlobMatcher>();
  const matcherFor = (pattern: string): GlobMatcher => {
    const normalized = normalizePattern(pattern);
    const existing = matcherCache.get(normalized);
    if (existing !== undefined) {
      return existing;
    }
    const created = new bun.Glob(normalized);
    matcherCache.set(normalized, created);
    return created;
  };
  const positiveMatchers: GlobMatcher[] = [];
  const negativeMatchers: GlobMatcher[] = [];
  for (const pattern of includes) {
    if (pattern.startsWith("!")) {
      negativeMatchers.push(matcherFor(pattern));
    } else {
      positiveMatchers.push(matcherFor(pattern));
    }
  }

  const selected: string[] = [];
  for (const file of candidates) {
    if (!isSupportedSourceFile(file)) {
      continue;
    }
    if (
      positiveMatchers.length > 0 &&
      !positiveMatchers.some((matcher) => matchesPattern(matcher, file))
    ) {
      continue;
    }
    if (negativeMatchers.some((matcher) => matchesPattern(matcher, file))) {
      continue;
    }
    selected.push(file);
  }
  selected.sort((left, right) => left.localeCompare(right));
  return selected;
}
