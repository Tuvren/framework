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

import oxfmtConfig from "../../oxfmt.config.js";
import {
  FORMER_ROOT_DELETED_COMMAND,
  FORMER_ROOT_DISCOVERY_COMMAND,
  parseGitFileList,
  removeDeletedFiles,
  selectFormerRootFiles,
} from "./lib/biome-inventory.js";
import {
  runCommand as runCommandProcess,
  type RunCommandResult,
} from "./lib/command-runner.js";
import {
  isCodeFile,
  isJsonFile,
  JSON_SOURCE_INTEGRITY_EXCLUSIONS,
  selectJsonInventory,
} from "./lib/json-source-integrity.js";
import {
  collectOxlintSelectedFiles,
  discoverNativeLintProjects,
} from "./lib/native-lint-routing.js";
import { loadNxProjectFiles, type NxProjectFile } from "./lib/nx-projects.js";

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
  jsonValidatedFiles: string[];
  missing: string[];
  oxlintFiles: string[];
  perList: Map<CoverageListId, string[]>;
  protectedFiles: string[];
}

export interface DuplicateAssignment {
  lists: string[];
  path: string;
}

export interface NativeCoverage {
  jsonValidatedFiles: readonly string[];
  oxlintFiles: readonly string[];
  protectedFiles?: readonly string[];
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
  /** Set when former-root discovery could not produce a trusted inventory. */
  discoveryError: string | undefined;
  duplicates: DuplicateAssignment[];
  failed: boolean;
  formatGateCode: number | undefined;
  inventorySize: number;
  jsonSourceGateCode: number | undefined;
  jsonValidatedFiles: string[];
  missing: string[];
  oxlintFiles: string[];
  oxcRuns: OxcRun[];
  protectedFiles: string[];
  surfaceGateCode: number | undefined;
}

interface NativeJsonProject {
  jsonOnly: boolean;
  name: string;
  root: string;
}

interface NativeJsonSelection {
  error: string | undefined;
  jsonValidatedFiles: string[];
  protectedFiles: string[];
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
const JSON_SOURCE_GATE_RELATIVE = "tools/scripts/json-source-check.ts";
const GLOB_METACHARACTER_PATTERN = /[*?[\]{}]/;

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

interface CoverageAccumulator {
  duplicates: DuplicateAssignment[];
  jsonValidated: ReadonlySet<string>;
  jsonValidatedFiles: string[];
  missing: string[];
  oxlint: ReadonlySet<string>;
  oxlintFiles: string[];
  perList: Map<CoverageListId, string[]>;
  protected: ReadonlySet<string>;
}

function assignNativeCoverage(
  file: string,
  matches: readonly CoverageEntry[],
  state: CoverageAccumulator
): boolean {
  const nativeOwners: string[] = [];
  if (state.oxlint.has(file)) {
    nativeOwners.push("oxlint");
  }
  if (state.jsonValidated.has(file)) {
    nativeOwners.push("json-source-check");
  }
  if (state.protected.has(file)) {
    nativeOwners.push("json-source-protected");
  }
  if (nativeOwners.length === 0) {
    return false;
  }
  if (matches.length > 0 || nativeOwners.length > 1) {
    state.duplicates.push({
      lists: [
        ...new Set([...nativeOwners, ...matches.map((entry) => entry.list)]),
      ],
      path: file,
    });
  } else if (nativeOwners[0] === "oxlint") {
    state.oxlintFiles.push(file);
  } else if (nativeOwners[0] === "json-source-check") {
    state.jsonValidatedFiles.push(file);
  }
  return true;
}

function assignRetainedCoverage(
  file: string,
  matches: readonly CoverageEntry[],
  state: CoverageAccumulator
): void {
  if (matches.length === 0) {
    state.missing.push(file);
    return;
  }
  const deepest = Math.max(...matches.map((match) => pathDepth(match.path)));
  const specific = matches.filter((match) => pathDepth(match.path) === deepest);
  const specificPaths = new Set(specific.map((match) => match.path));
  if (specificPaths.size > 1) {
    state.duplicates.push({
      lists: [...new Set(specific.map((match) => match.list))],
      path: file,
    });
    return;
  }
  const owner = specific[0];
  if (owner === undefined) {
    state.missing.push(file);
    return;
  }
  state.perList.get(owner.list)?.push(file);
}

export function resolveCoverage(
  inventory: readonly string[],
  entries: readonly CoverageEntry[],
  native: NativeCoverage
): CoverageResolution {
  const perList = new Map<CoverageListId, string[]>();
  for (const id of COVERAGE_LIST_IDS) {
    perList.set(id, []);
  }

  const missing: string[] = [];
  const jsonValidatedFiles: string[] = [];
  const oxlintFiles: string[] = [];
  const protectedFiles = [...(native.protectedFiles ?? [])].sort(
    (left, right) => left.localeCompare(right)
  );
  const jsonValidated = new Set(native.jsonValidatedFiles);
  const oxlint = new Set(native.oxlintFiles);
  const duplicates = findDuplicateEntries(entries);
  const state: CoverageAccumulator = {
    duplicates,
    jsonValidated,
    jsonValidatedFiles,
    missing,
    oxlint,
    oxlintFiles,
    perList,
    protected: new Set(protectedFiles),
  };

  for (const file of inventory) {
    const matches = entries.filter((entry) => isWithin(file, entry.path));
    if (assignNativeCoverage(file, matches, state)) {
      continue;
    }
    assignRetainedCoverage(file, matches, state);
  }
  duplicates.sort((left, right) => left.path.localeCompare(right.path));

  for (const files of perList.values()) {
    files.sort((left, right) => left.localeCompare(right));
  }

  missing.sort((left, right) => left.localeCompare(right));
  jsonValidatedFiles.sort((left, right) => left.localeCompare(right));
  oxlintFiles.sort((left, right) => left.localeCompare(right));

  return {
    duplicates,
    jsonValidatedFiles,
    missing,
    oxlintFiles,
    perList,
    protectedFiles,
  };
}

function failedDiscovery(message: string): LintGateResult {
  return {
    biomeRuns: [],
    discoveryError: `former-root discovery failed: ${message}`,
    duplicates: [],
    failed: true,
    formatGateCode: undefined,
    inventorySize: 0,
    jsonSourceGateCode: undefined,
    jsonValidatedFiles: [],
    missing: [],
    oxlintFiles: [],
    oxcRuns: [],
    protectedFiles: [],
    surfaceGateCode: undefined,
  };
}

function collectNativeJsonSelection(
  candidates: readonly string[],
  inventory: ReadonlySet<string>,
  projects: readonly NativeJsonProject[],
  sourceIgnorePatterns: readonly string[]
): NativeJsonSelection {
  const jsonValidated = new Set<string>();
  const protectedFiles = new Set<string>();
  for (const project of projects) {
    const selection = selectJsonInventory(
      candidates,
      [project.root],
      sourceIgnorePatterns,
      oxfmtConfig.ignorePatterns ?? []
    );
    if (project.jsonOnly && selection.codeFiles.length > 0) {
      return {
        error: `JSON-only scope contains code: ${selection.codeFiles.join(", ")}`,
        jsonValidatedFiles: [],
        protectedFiles: [],
      };
    }
    if (selection.jsonFiles.length === 0) {
      return {
        error: `native JSON source selection is empty for ${project.name} (${project.root})`,
        jsonValidatedFiles: [],
        protectedFiles: [],
      };
    }
    for (const file of selection.jsonFiles) {
      if (inventory.has(file)) {
        jsonValidated.add(file);
      }
    }
    for (const file of selection.protectedFiles) {
      if (inventory.has(file)) {
        protectedFiles.add(file);
      }
    }
  }
  return {
    error: undefined,
    jsonValidatedFiles: [...jsonValidated],
    protectedFiles: [...protectedFiles],
  };
}

export async function runLintGate(
  deps: LintGateDependencies
): Promise<LintGateResult> {
  const entries = readCoverageEntries(deps.coverageDir);

  let inventory: string[];
  let candidates: string[];
  try {
    const discovery = await deps.runCommand(FORMER_ROOT_DISCOVERY_COMMAND, {
      captureOutput: true,
      cwd: deps.repoRoot,
    });
    if (discovery.code !== 0) {
      return failedDiscovery(`command exited with code ${discovery.code}`);
    }
    const deletion = await deps.runCommand(FORMER_ROOT_DELETED_COMMAND, {
      captureOutput: true,
      cwd: deps.repoRoot,
    });
    if (deletion.code !== 0) {
      return failedDiscovery(
        `deletion check exited with code ${deletion.code}`
      );
    }
    candidates = removeDeletedFiles(
      parseGitFileList(discovery.stdout),
      parseGitFileList(deletion.stdout)
    );
    inventory = selectFormerRootFiles(deps.repoRoot, candidates);
  } catch (error: unknown) {
    return failedDiscovery(
      error instanceof Error ? error.message : String(error)
    );
  }

  const nativeProjects = discoverNativeLintProjects(
    deps.listProjectFiles(deps.repoRoot)
  );
  let oxlintSelected: string[];
  try {
    oxlintSelected = await collectOxlintSelectedFiles(
      nativeProjects.oxcProjects,
      deps
    );
  } catch (error: unknown) {
    return failedDiscovery(
      error instanceof Error ? error.message : String(error)
    );
  }
  const inventorySet = new Set(inventory);
  const unsupportedSelection = oxlintSelected.find(
    (file) => !inventorySet.has(file)
  );
  if (unsupportedSelection !== undefined) {
    return failedDiscovery(
      `Oxlint selected ${unsupportedSelection} outside the former-root inventory`
    );
  }

  const jsonProjects: NativeJsonProject[] = [
    ...nativeProjects.oxcProjects
      .filter((project) => project.jsonCompanion)
      .map((project) => ({ ...project, jsonOnly: false })),
    ...nativeProjects.jsonOnlyProjects.map((project) => ({
      ...project,
      jsonOnly: true,
    })),
  ];
  const nativeJsonSelection = collectNativeJsonSelection(
    candidates,
    inventorySet,
    jsonProjects,
    JSON_SOURCE_INTEGRITY_EXCLUSIONS
  );
  if (nativeJsonSelection.error !== undefined) {
    return failedDiscovery(nativeJsonSelection.error);
  }
  const protectedFiles = [
    ...new Set([
      ...nativeJsonSelection.protectedFiles,
      ...candidates.filter(
        (file) =>
          (isCodeFile(file) || isJsonFile(file)) && !inventorySet.has(file)
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const resolution = resolveCoverage(inventory, entries, {
    jsonValidatedFiles: nativeJsonSelection.jsonValidatedFiles,
    oxlintFiles: oxlintSelected,
    protectedFiles,
  });

  const biomeRuns: BiomeRun[] = [];
  const oxcRuns: OxcRun[] = [];

  if (
    inventory.length === 0 ||
    resolution.missing.length > 0 ||
    resolution.duplicates.length > 0
  ) {
    return {
      biomeRuns,
      discoveryError:
        inventory.length === 0 ? "former-root inventory is empty" : undefined,
      duplicates: resolution.duplicates,
      failed: true,
      formatGateCode: undefined,
      inventorySize: inventory.length,
      jsonSourceGateCode: undefined,
      jsonValidatedFiles: resolution.jsonValidatedFiles,
      missing: resolution.missing,
      oxlintFiles: resolution.oxlintFiles,
      oxcRuns,
      protectedFiles: resolution.protectedFiles,
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

  const jsonSourceGate = await deps.runCommand(
    [process.execPath, JSON_SOURCE_GATE_RELATIVE, "."],
    { cwd: deps.repoRoot }
  );

  const formatGate = await deps.runCommand(
    [process.execPath, "run", "format:check"],
    { cwd: deps.repoRoot }
  );

  const projectsToRun = [
    ...nativeProjects.oxcProjects,
    ...nativeProjects.jsonOnlyProjects,
  ].sort((left, right) => left.name.localeCompare(right.name));
  for (const project of projectsToRun) {
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
    jsonSourceGate.code !== 0 ||
    formatGate.code !== 0 ||
    oxcRuns.some((run) => run.code !== 0);

  return {
    biomeRuns,
    discoveryError: undefined,
    duplicates: resolution.duplicates,
    failed,
    formatGateCode: formatGate.code,
    inventorySize: inventory.length,
    jsonSourceGateCode: jsonSourceGate.code,
    jsonValidatedFiles: resolution.jsonValidatedFiles,
    missing: resolution.missing,
    oxlintFiles: resolution.oxlintFiles,
    oxcRuns,
    protectedFiles: resolution.protectedFiles,
    surfaceGateCode: surfaceGate.code,
  };
}

function reportFailure(result: LintGateResult): void {
  if (result.discoveryError !== undefined) {
    console.error(`biome-lint: ${result.discoveryError}`);
  } else if (result.inventorySize === 0) {
    console.error(
      "biome-lint: no former-root files were discovered; refusing to treat an empty inventory as complete coverage."
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
