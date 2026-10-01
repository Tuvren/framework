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

import { readFileSync } from "node:fs";
import path from "node:path";

import { build, Glob, JSONC } from "bun";

import type { RunCommandResult } from "./command-runner.js";

export const JSON_DISCOVERY_COMMAND = [
  "git",
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
] as const;

export const JSON_DELETED_COMMAND = [
  "git",
  "ls-files",
  "-z",
  "--deleted",
] as const;

const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);
const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const CONFIG_JSON_PATTERN = /^(?:jsconfig|tsconfig(?:\.[^.]+)*)\.json$/u;
const LEADING_BANGS_PATTERN = /^!+/u;
const GLOB_METACHARACTER_PATTERN = /[*?[\]{}]/u;
const BACKSLASH_PATTERN = /\\/gu;
const TRAILING_SLASH_PATTERN = /\/+$/u;
const LEADING_DOT_SLASH_PATTERN = /^\.\//u;

/**
 * Repository-owned exclusions from native JSON source validation. This policy
 * is deliberately independent of formatter configuration: formatter-only
 * exclusions remain eligible for source-integrity validation.
 */
export const JSON_SOURCE_INTEGRITY_EXCLUSIONS = Object.freeze([
  "**/_generated",
  "**/*.gen.*",
  "**/.next",
  "**/next-env.d.ts",
  "**/.nuxt",
  "**/.output",
  "**/.svelte-kit",
  "**/.vitepress/cache",
  "**/.vitepress/dist",
  "**/dist",
  "**/build",
  "**/out",
  "**/.turbo",
  "**/.vercel",
  "**/.netlify",
  "**/storybook-static",
  "**/.docusaurus",
  "**/.cache",
  "**/public/build",
  "**/.parcel-cache",
  "**/.vite",
  "**/.astro",
  "**/_astro",
  "**/coverage",
  "**/.nyc_output",
  "**/*.generated.*",
  "**/*.auto.*",
  "**/generated",
  "**/auto-generated",
  "**/codegen",
  "**/__generated__",
  "**/graphql-types.*",
  "**/schema.d.ts",
  "**/schema.graphql.d.ts",
  "**/*.d.ts.map",
  "**/.expo",
  "**/.expo-shared",
  "**/android/build",
  "**/ios/build",
  "**/DerivedData/**/*",
  "target",
  ".claude",
  ".dart_tool",
  ".constitution/**",
]);

interface GlobMatcher {
  match(value: string): boolean;
}

export interface JsonInventory {
  codeFiles: string[];
  formatFiles: string[];
  jsonFiles: string[];
  protectedFiles: string[];
  protectedReasons: JsonProtectedFile[];
}

export interface JsonProtectedFile {
  file: string;
  pattern: string;
  reason: "source-integrity-exclusion";
}

export interface JsonIntegrityIssue {
  file: string;
  message: string;
}

export interface JsonIntegrityResult {
  files: string[];
  issues: JsonIntegrityIssue[];
}

export interface JsonDiscoveryRunOptions {
  captureOutput?: boolean;
  cwd?: string;
}

export interface JsonDiscoveryDependencies {
  formatIgnorePatterns: readonly string[];
  repoRoot: string;
  runCommand: (
    command: readonly string[],
    options?: JsonDiscoveryRunOptions
  ) => Promise<RunCommandResult>;
  scopes: readonly string[];
  sourceIgnorePatterns: readonly string[];
}

export function parseGitFileList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

export function removeDeletedFiles(
  candidates: readonly string[],
  deleted: readonly string[]
): string[] {
  const deletedPaths = new Set(deleted);
  return candidates.filter((file) => !deletedPaths.has(file));
}

function extensionOf(file: string): string {
  return path.posix.extname(file).toLowerCase();
}

export function isJsonFile(file: string): boolean {
  return JSON_EXTENSIONS.has(extensionOf(file));
}

export function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(file));
}

function normalizeRepoRelative(value: string, source: string): string {
  // Git's `-z` output is already repository-relative and slash-separated on
  // Windows. On POSIX, a backslash is a legal filename byte, so only CLI
  // scopes entered on Windows may reinterpret it as a directory separator.
  const slashNormalized =
    path.sep === "\\" ? value.replace(BACKSLASH_PATTERN, "/") : value;
  if (slashNormalized.startsWith("/")) {
    throw new Error(`${source}: scope must be repository-relative: ${value}`);
  }
  if (GLOB_METACHARACTER_PATTERN.test(slashNormalized)) {
    throw new Error(`${source}: scope must be a literal path: ${value}`);
  }
  const segments = slashNormalized.split("/");
  if (segments.includes("..")) {
    throw new Error(
      `${source}: scope must not escape the repository: ${value}`
    );
  }
  const normalized = path.posix
    .normalize(slashNormalized)
    .replace(LEADING_DOT_SLASH_PATTERN, "")
    .replace(TRAILING_SLASH_PATTERN, "");
  if (normalized === "" || normalized === ".") {
    return ".";
  }
  return normalized;
}

export function normalizeJsonScopes(scopes: readonly string[]): string[] {
  if (scopes.length === 0) {
    throw new Error("at least one JSON scope is required");
  }
  return scopes.map((scope) => normalizeRepoRelative(scope, "json-check"));
}

function isWithinScope(file: string, scope: string): boolean {
  return scope === "." || file === scope || file.startsWith(`${scope}/`);
}

function matchesPattern(matcher: GlobMatcher, file: string): boolean {
  if (matcher.match(file)) {
    return true;
  }
  const segments = file.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    if (matcher.match(segments.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
}

function matchingPattern(
  file: string,
  ignoreMatchers: readonly { matcher: GlobMatcher; pattern: string }[]
): string | undefined {
  return ignoreMatchers.find(({ matcher }) => matchesPattern(matcher, file))
    ?.pattern;
}

export function selectJsonInventory(
  candidates: readonly string[],
  scopes: readonly string[],
  sourceIgnorePatterns: readonly string[],
  formatIgnorePatterns: readonly string[] = []
): JsonInventory {
  const normalizedScopes = normalizeJsonScopes(scopes);
  const matchers = (patterns: readonly string[]) =>
    patterns.map((pattern) => ({
      matcher: new Glob(pattern.replace(LEADING_BANGS_PATTERN, "")),
      pattern,
    }));
  const sourceIgnoreMatchers = matchers(sourceIgnorePatterns);
  const formatIgnoreMatchers = matchers(formatIgnorePatterns);
  const jsonFiles: string[] = [];
  const formatFiles: string[] = [];
  const codeFiles: string[] = [];
  const protectedFiles: string[] = [];
  const protectedReasons: JsonProtectedFile[] = [];

  for (const candidate of candidates) {
    // Candidate paths came from `git ls-files -z`; preserve them byte-for-byte
    // so a legal POSIX backslash remains part of the filename used for reads.
    const file = candidate;
    if (!normalizedScopes.some((scope) => isWithinScope(file, scope))) {
      continue;
    }
    if (!(isJsonFile(file) || isCodeFile(file))) {
      continue;
    }
    if (isCodeFile(file)) {
      codeFiles.push(file);
      continue;
    }
    const sourceIgnorePattern = matchingPattern(file, sourceIgnoreMatchers);
    if (sourceIgnorePattern !== undefined) {
      protectedFiles.push(file);
      protectedReasons.push({
        file,
        pattern: sourceIgnorePattern,
        reason: "source-integrity-exclusion",
      });
      continue;
    }
    jsonFiles.push(file);
    if (matchingPattern(file, formatIgnoreMatchers) === undefined) {
      formatFiles.push(file);
    }
  }

  for (const files of [codeFiles, formatFiles, jsonFiles, protectedFiles]) {
    files.sort((left, right) => left.localeCompare(right));
  }
  protectedReasons.sort((left, right) => left.file.localeCompare(right.file));
  return {
    codeFiles,
    formatFiles,
    jsonFiles,
    protectedFiles,
    protectedReasons,
  };
}

export async function discoverJsonInventory(
  deps: JsonDiscoveryDependencies
): Promise<JsonInventory> {
  const discovery = await deps.runCommand(JSON_DISCOVERY_COMMAND, {
    captureOutput: true,
    cwd: deps.repoRoot,
  });
  if (discovery.code !== 0) {
    throw new Error(`JSON discovery exited with code ${discovery.code}`);
  }
  const deletion = await deps.runCommand(JSON_DELETED_COMMAND, {
    captureOutput: true,
    cwd: deps.repoRoot,
  });
  if (deletion.code !== 0) {
    throw new Error(`JSON deletion check exited with code ${deletion.code}`);
  }
  return selectJsonInventory(
    removeDeletedFiles(
      parseGitFileList(discovery.stdout),
      parseGitFileList(deletion.stdout)
    ),
    deps.scopes,
    deps.sourceIgnorePatterns,
    deps.formatIgnorePatterns
  );
}

export function isJsoncProfile(
  file: string,
  pathSemantics: Pick<typeof path, "basename" | "normalize" | "sep"> = path
): boolean {
  // Callers pass native absolute paths. Normalize with the host's path rules so
  // Windows separators are recognized without reinterpreting valid POSIX
  // backslashes as directory separators.
  const normalized = pathSemantics.normalize(file);
  const basename = pathSemantics.basename(normalized);
  if (normalized.endsWith(".jsonc") || CONFIG_JSON_PATTERN.test(basename)) {
    return true;
  }
  return normalized.split(pathSemantics.sep).includes(".vscode");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonSource(
  file: string,
  source: string
): JsonIntegrityIssue | undefined {
  try {
    if (isJsoncProfile(file)) {
      JSONC.parse(source);
    } else {
      JSON.parse(source);
    }
    return undefined;
  } catch (error: unknown) {
    return { file, message: errorMessage(error) };
  }
}

/**
 * Validate JSON source without writing output. Strict JSON and the repository's
 * established JSONC profiles are parsed first. Bun's native loader then adds
 * duplicate-key diagnostics, including escaped-equivalent and nested keys.
 */
export async function validateJsonSources(
  files: readonly string[]
): Promise<JsonIntegrityResult> {
  const ordered = [...files].sort((left, right) => left.localeCompare(right));
  const issues: JsonIntegrityIssue[] = [];
  const buildable: string[] = [];
  const buildSources: Record<string, string> = {};
  const sourceFiles = new Map<string, string>();

  for (const file of ordered) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error: unknown) {
      issues.push({ file, message: errorMessage(error) });
      continue;
    }
    const parseIssue = parseJsonSource(file, source);
    if (parseIssue === undefined) {
      // Keep Git filenames out of Bun's virtual module identifiers. On POSIX,
      // a literal backslash is valid in a filename but has module-path meaning
      // to the bundler; a synthetic key preserves exact source lookup while
      // keeping duplicate-key diagnostics mapped back to the original path.
      const buildPath = `.tuvren-json-source/${buildable.length}.jsonc`;
      buildable.push(buildPath);
      buildSources[buildPath] = source;
      sourceFiles.set(buildPath, file);
    } else {
      issues.push(parseIssue);
    }
  }

  if (buildable.length > 0) {
    const buildResult = await build({
      entrypoints: buildable,
      // Syntax policy is already enforced above. Virtual .jsonc entrypoints
      // keep Bun's narrower filename heuristics (notably for .vscode/*.json)
      // from changing that policy; this pass supplies duplicate-key
      // diagnostics only and writes no artifacts.
      files: buildSources,
      target: "bun",
      throw: false,
    });
    if (!buildResult.success && buildResult.logs.length === 0) {
      issues.push({ file: "<json-build>", message: "Bun JSON build failed" });
    }
    for (const diagnostic of buildResult.logs) {
      const buildFile = diagnostic.position?.file;
      const diagnosticFile =
        buildFile === undefined
          ? "<json-build>"
          : (sourceFiles.get(buildFile) ?? buildFile);
      issues.push({ file: diagnosticFile, message: diagnostic.message });
    }
  }

  return { files: ordered, issues };
}
