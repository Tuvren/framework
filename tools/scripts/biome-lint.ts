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

// KRT-BP008 / ADR-0070. The root Biome gate is lint-only and routed over an
// explicit per-directory coverage inventory. Each not-yet-migrated directory
// owns one list under tools/biome-coverage (bq.json … ca.json); residual.json
// owns root, configuration, spec, compatibility and constitution inputs. Every
// file Biome still processes must belong to exactly one list. A directory epic
// removes its own migrated entries only, so a project that switches to OXC
// leaves Biome coverage in the same change. Nested entries are resolved by the
// most specific owner, so a broad residual directory never double-lints a file
// already owned by a narrower group. An empty list skips Biome entirely and
// never expands to the repository.

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  runCommand as runCommandProcess,
  type RunCommandResult,
} from "./lib/command-runner.js";
import {
  loadNxProjectFiles,
  targetCommandStrings,
  type NxProjectFile,
} from "./lib/nx-projects.js";

export const COVERAGE_LIST_IDS = [
  "bq",
  "br",
  "bs",
  "bt",
  "bu",
  "bv",
  "bw",
  "bx",
  "by",
  "bz",
  "ca",
  "residual",
] as const;

export type CoverageListId = (typeof COVERAGE_LIST_IDS)[number];

export interface CoverageEntry {
  list: CoverageListId;
  path: string;
}

export interface CoverageResolution {
  duplicates: DuplicateAssignment[];
  missing: string[];
  oxcExcluded: string[];
  perList: Map<CoverageListId, string[]>;
}

export interface DuplicateAssignment {
  lists: CoverageListId[];
  path: string;
}

export interface OxcProject {
  name: string;
  root: string;
}

export interface LintGateRunOptions {
  captureOutput?: boolean;
  cwd?: string;
}

export interface LintGateDependencies {
  coverageDir: string;
  listProjectFiles: (root: string) => readonly NxProjectFile[];
  repoRoot: string;
  runCommand: (
    command: readonly string[],
    options?: LintGateRunOptions
  ) => Promise<RunCommandResult>;
}

export interface BiomeRun {
  code: number;
  files: string[];
  list: CoverageListId;
}

export interface OxcRun {
  code: number;
  target: string;
}

export interface LintGateResult {
  biomeRuns: BiomeRun[];
  duplicates: DuplicateAssignment[];
  failed: boolean;
  inventorySize: number;
  missing: string[];
  oxcExcluded: string[];
  oxcRuns: OxcRun[];
  surfaceGateCode: number | undefined;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIOME_BIN = path.join(
  REPO_ROOT,
  "node_modules",
  "@biomejs",
  "biome",
  "bin",
  "biome"
);
const COVERAGE_DIR_RELATIVE = "tools/biome-coverage";
const SURFACE_GATE_RELATIVE = "tools/scripts/kraken-surface-gate.ts";
const OXLINT_LINT_MARKER = /\boxlint\b/;
const GLOB_METACHARACTER_PATTERN = /[*?[\]{}]/;
const VERBOSE_FILE_LINE_PATTERN = /^\s*-\s+(.+?)\s*$/;
const BIOME_INVENTORY_ARGS = [
  "lint",
  ".",
  "--verbose",
  "--max-diagnostics=0",
  "--colors=off",
] as const;

function biomeInventoryCommand(): string[] {
  return [process.execPath, BIOME_BIN, ...BIOME_INVENTORY_ARGS];
}

function normalizeEntry(value: string, source: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.length === 0) {
    throw new Error(`${source}: coverage entries must be non-empty paths`);
  }
  if (normalized.startsWith("/")) {
    throw new Error(
      `${source}: coverage entries must be repository-relative, got "${value}"`
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(
      `${source}: coverage entries must not escape the repository, got "${value}"`
    );
  }
  if (GLOB_METACHARACTER_PATTERN.test(normalized)) {
    throw new Error(
      `${source}: coverage entries must be literal paths, not globs, got "${value}"`
    );
  }
  return normalized;
}

export function readCoverageEntries(coverageDir: string): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const id of COVERAGE_LIST_IDS) {
    const file = path.join(coverageDir, `${id}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error: unknown) {
      throw new Error(`cannot read coverage list ${file}: ${String(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${file}: coverage list must be a JSON array`);
    }
    for (const value of parsed) {
      if (typeof value !== "string") {
        throw new Error(`${file}: coverage entries must be strings`);
      }
      entries.push({ list: id, path: normalizeEntry(value, file) });
    }
  }
  return entries;
}

function isWithin(file: string, candidate: string): boolean {
  return file === candidate || file.startsWith(`${candidate}/`);
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

export function findDuplicateEntries(
  entries: readonly CoverageEntry[]
): DuplicateAssignment[] {
  const listsByPath = new Map<string, CoverageListId[]>();
  for (const entry of entries) {
    const lists = listsByPath.get(entry.path) ?? [];
    lists.push(entry.list);
    listsByPath.set(entry.path, lists);
  }
  const duplicates: DuplicateAssignment[] = [];
  for (const [entryPath, lists] of listsByPath.entries()) {
    if (lists.length > 1) {
      duplicates.push({ lists: [...new Set(lists)], path: entryPath });
    }
  }
  duplicates.sort((left, right) => left.path.localeCompare(right.path));
  return duplicates;
}

export function resolveCoverage(
  inventory: readonly string[],
  entries: readonly CoverageEntry[],
  oxcRoots: readonly string[]
): CoverageResolution {
  const perList = new Map<CoverageListId, string[]>();
  for (const id of COVERAGE_LIST_IDS) {
    perList.set(id, []);
  }

  const missing: string[] = [];
  const oxcExcluded: string[] = [];
  const duplicates = findDuplicateEntries(entries);
  const ambiguous = new Map<string, CoverageListId[]>();

  for (const file of inventory) {
    if (oxcRoots.some((root) => isWithin(file, root))) {
      oxcExcluded.push(file);
      continue;
    }

    const matches = entries.filter((entry) => isWithin(file, entry.path));
    if (matches.length === 0) {
      missing.push(file);
      continue;
    }

    let deepest = 0;
    for (const match of matches) {
      deepest = Math.max(deepest, pathDepth(match.path));
    }
    const specific = matches.filter(
      (match) => pathDepth(match.path) === deepest
    );
    const specificPaths = new Set(specific.map((match) => match.path));
    if (specificPaths.size > 1) {
      // Two distinct entries at the same depth both claim the file: an
      // ambiguous assignment is a duplicate, never a silent pick.
      ambiguous.set(file, [...new Set(specific.map((match) => match.list))]);
      continue;
    }

    const owner = specific[0];
    if (owner === undefined) {
      missing.push(file);
      continue;
    }
    perList.get(owner.list)?.push(file);
  }

  for (const [file, lists] of ambiguous.entries()) {
    duplicates.push({ lists, path: file });
  }
  duplicates.sort((left, right) => left.path.localeCompare(right.path));

  for (const files of perList.values()) {
    files.sort((left, right) => left.localeCompare(right));
  }

  missing.sort((left, right) => left.localeCompare(right));
  oxcExcluded.sort((left, right) => left.localeCompare(right));

  return { duplicates, missing, oxcExcluded, perList };
}

export function parseBiomeInventory(verboseOutput: string): string[] {
  const files: string[] = [];
  let collecting = false;
  for (const line of verboseOutput.split("\n")) {
    if (line.includes("Files processed:")) {
      collecting = true;
      continue;
    }
    if (line.includes("Files fixed:")) {
      collecting = false;
      continue;
    }
    if (!collecting) {
      continue;
    }
    const match = VERBOSE_FILE_LINE_PATTERN.exec(line);
    if (match?.[1] !== undefined) {
      files.push(match[1]);
    }
  }
  return files;
}

export async function readBiomeInventory(repoRoot: string): Promise<string[]> {
  const result = await runCommandProcess(biomeInventoryCommand(), {
    captureOutput: true,
    cwd: repoRoot,
  });
  return parseBiomeInventory(result.stdout);
}

export function discoverOxcProjects(
  projectFiles: readonly NxProjectFile[]
): OxcProject[] {
  const projects: OxcProject[] = [];
  for (const file of projectFiles) {
    const lintTarget = file.project.targets?.lint;
    if (lintTarget === undefined) {
      continue;
    }
    const commands = targetCommandStrings(lintTarget);
    if (!commands.some((command) => OXLINT_LINT_MARKER.test(command))) {
      continue;
    }
    // Every project.json in this repository declares a `root` that equals its
    // own directory; using the path directory keeps the loader unchanged and
    // the value identical.
    projects.push({ name: file.name, root: path.dirname(file.path) });
  }
  projects.sort((left, right) => left.name.localeCompare(right.name));
  return projects;
}

export async function runLintGate(
  deps: LintGateDependencies
): Promise<LintGateResult> {
  const entries = readCoverageEntries(deps.coverageDir);
  const inventoryResult = await deps.runCommand(biomeInventoryCommand(), {
    captureOutput: true,
    cwd: deps.repoRoot,
  });
  const inventory = parseBiomeInventory(inventoryResult.stdout);
  const oxcProjects = discoverOxcProjects(
    deps.listProjectFiles(deps.repoRoot)
  );
  const resolution = resolveCoverage(
    inventory,
    entries,
    oxcProjects.map((project) => project.root)
  );

  const biomeRuns: BiomeRun[] = [];
  const oxcRuns: OxcRun[] = [];

  if (
    inventory.length === 0 ||
    resolution.missing.length > 0 ||
    resolution.duplicates.length > 0
  ) {
    return {
      biomeRuns,
      duplicates: resolution.duplicates,
      failed: true,
      inventorySize: inventory.length,
      missing: resolution.missing,
      oxcExcluded: resolution.oxcExcluded,
      oxcRuns,
      surfaceGateCode: undefined,
    };
  }

  for (const id of COVERAGE_LIST_IDS) {
    const files = resolution.perList.get(id) ?? [];
    if (files.length === 0) {
      // An empty list skips Biome; it never expands to the repository.
      continue;
    }
    const result = await deps.runCommand(
      [process.execPath, BIOME_BIN, "lint", ...files],
      { cwd: deps.repoRoot }
    );
    biomeRuns.push({ code: result.code, files, list: id });
  }

  const surfaceGate = await deps.runCommand(
    [process.execPath, SURFACE_GATE_RELATIVE],
    { cwd: deps.repoRoot }
  );

  for (const project of oxcProjects) {
    const target = `${project.name}:lint`;
    const result = await deps.runCommand(
      [process.execPath, "run", "nx", "run", target],
      { cwd: deps.repoRoot }
    );
    oxcRuns.push({ code: result.code, target });
  }

  const failed =
    biomeRuns.some((run) => run.code !== 0) ||
    surfaceGate.code !== 0 ||
    oxcRuns.some((run) => run.code !== 0);

  return {
    biomeRuns,
    duplicates: resolution.duplicates,
    failed,
    inventorySize: inventory.length,
    missing: resolution.missing,
    oxcExcluded: resolution.oxcExcluded,
    oxcRuns,
    surfaceGateCode: surfaceGate.code,
  };
}

function reportFailure(result: LintGateResult): void {
  if (result.inventorySize === 0) {
    console.error(
      "biome-lint: Biome reported no files; refusing to treat an empty inventory as complete coverage."
    );
  }
  for (const file of result.missing) {
    console.error(
      `biome-lint: ${file} is not assigned to any tools/biome-coverage list.`
    );
  }
  for (const duplicate of result.duplicates) {
    console.error(
      `biome-lint: ${duplicate.path} is assigned to multiple coverage lists (${duplicate.lists.join(", ")}).`
    );
  }
}

const isDirectRun = (import.meta as { main?: boolean }).main === true;

if (isDirectRun) {
  const result = await runLintGate({
    coverageDir: path.join(REPO_ROOT, COVERAGE_DIR_RELATIVE),
    listProjectFiles: loadNxProjectFiles,
    repoRoot: REPO_ROOT,
    runCommand: runCommandProcess,
  });

  if (result.failed) {
    reportFailure(result);
    process.exitCode = 1;
  }
}
