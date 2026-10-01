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
  loadNxProjectFiles,
  type NxCommandOptions,
  type NxProjectFile,
  type NxProjectTarget,
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
  /** Set when former-root discovery could not produce a trusted inventory. */
  discoveryError: string | undefined;
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
// The only command that may credit a whole project root to OXC. ADR-0070's
// directory ratchet switches each project lint target to `oxlint --type-aware`;
// a partial path (`oxlint src`), an extra ignore/scope flag, a writer flag or a
// differently-qualified binary must never subtract a project's whole file set
// from the retained Biome gate. Match the canonical direct `bunx --bun`
// invocation with an optional single directory operand instead of parsing a
// general shell command line.
const OXLINT_PROJECT_WIDE_COMMAND_PATTERN =
  /^bunx --bun oxlint --type-aware(?: (?<operand>\S+))?$/u;
const GLOB_METACHARACTER_PATTERN = /[*?[\]{}]/;
const BACKSLASH_PATTERN = /\\/gu;
const TRAILING_SLASH_PATTERN = /\/+$/u;
// The only executor that forwards extra options to its command. A custom
// executor may carry a canonical-looking `command`, but it does not run the
// nx:run-commands argument merge this gate models.
const RUN_COMMANDS_EXECUTOR = "nx:run-commands";
// nx:run-commands only treats these option keys as inert for the executed
// command: it reads `command`/`commands` and resolves `cwd`.
// normalizeOptions appends `options.args`, `options.__unparsed__` and every
// unrecognized scalar option (`--key=value`) to the command, so crediting a
// whole project root is safe only for this exact allowlist. Anything else
// fails closed and keeps the target on the retained Biome gate.
const SCOPE_SAFE_RUN_COMMANDS_OPTION_KEYS: ReadonlySet<string> = new Set([
  "command",
  "commands",
  "cwd",
]);

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

interface InvokedLintCommand {
  command: string;
  cwd: string;
}

/**
 * The options `nx run <project>:lint` actually executes: the base `options`
 * shallow-merged with the target's `defaultConfiguration` override, matching
 * Nx's combineOptionsForExecutor (the selected configuration wins per option;
 * an unselected named configuration is never inspected).
 */
function selectDefaultTargetOptions(
  target: NxProjectTarget
): NxCommandOptions | undefined {
  const selected =
    target.defaultConfiguration === undefined
      ? undefined
      : target.configurations?.[target.defaultConfiguration];
  if (target.options === undefined && selected === undefined) {
    return undefined;
  }
  return { ...target.options, ...selected };
}

/**
 * Rejects any option the executor could append to the command text. Only the
 * scope-safe allowlist above is accepted; `args`, `__unparsed__`, a forwarded
 * `--ignore-pattern`, `forwardAllArgs` and every other key fail closed.
 */
function hasOnlyScopeSafeOptions(options: NxCommandOptions): boolean {
  return Object.keys(options).every((key) =>
    SCOPE_SAFE_RUN_COMMANDS_OPTION_KEYS.has(key)
  );
}

/**
 * The single command a target runs. `nx:run-commands` ignores `commands` when a
 * single `command` is set (normalizeOptions), and exactly one command is
 * required so a target cannot hide a partial scope behind an unrelated primary
 * command. A `commands` array with zero or several entries is rejected, as is a
 * command entry object carrying metadata beyond its `command` text.
 */
function invokedCommand(
  options: NxCommandOptions
): InvokedLintCommand | undefined {
  let command: string | undefined;
  if (typeof options.command === "string") {
    command = options.command;
  } else {
    const entries = options.commands ?? [];
    if (entries.length === 1) {
      const entry = entries[0];
      if (typeof entry === "string") {
        command = entry;
      } else if (
        entry !== null &&
        typeof entry === "object" &&
        Object.keys(entry).length === 1 &&
        typeof entry.command === "string"
      ) {
        command = entry.command;
      }
    }
  }
  if (typeof command !== "string") {
    return undefined;
  }
  const cwd = options.cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    return undefined;
  }
  return { command, cwd: cwd ?? "." };
}

// Rejects anything outside the repository-relative directory tree: absolute
// paths, `..` escapes and globs are not a project-root scope. Returns the
// normalized POSIX directory, or undefined when the value is unusable.
function normalizeRepoRelative(value: string): string | undefined {
  const normalized = value.replace(BACKSLASH_PATTERN, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    GLOB_METACHARACTER_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) {
    return undefined;
  }
  const collapsed = path.posix
    .normalize(normalized)
    .replace(TRAILING_SLASH_PATTERN, "");
  if (collapsed === "" || collapsed === ".." || collapsed.startsWith("../")) {
    return undefined;
  }
  return collapsed;
}

/**
 * True only when the invoked command lints exactly the project directory and
 * nothing narrower: the operand resolved against the working directory must be
 * the project's own root. `cwd: "."` with the project path and `cwd:
 * <project>` with `.` (or no operand) both qualify; `cwd: "."` with a bare `.`
 * is a whole-repository lint and is rejected.
 */
function isProjectWideOxlintScope(
  invoked: InvokedLintCommand,
  projectRoot: string
): boolean {
  const match = OXLINT_PROJECT_WIDE_COMMAND_PATTERN.exec(invoked.command);
  if (match === null) {
    return false;
  }
  const cwd = normalizeRepoRelative(invoked.cwd);
  const root = normalizeRepoRelative(projectRoot);
  if (cwd === undefined || root === undefined) {
    return false;
  }
  const operand = match.groups?.operand;
  if (operand === undefined) {
    return cwd === root;
  }
  const resolvedOperand = normalizeRepoRelative(operand);
  if (resolvedOperand === undefined) {
    return false;
  }
  return path.posix.normalize(path.posix.join(cwd, resolvedOperand)) === root;
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
    // Credit only the executor whose forwarding semantics this gate models. A
    // custom executor with a canonical-looking `command` option must not earn
    // whole-project coverage.
    if (lintTarget.executor !== RUN_COMMANDS_EXECUTOR) {
      continue;
    }
    const options = selectDefaultTargetOptions(lintTarget);
    if (options === undefined) {
      continue;
    }
    // Fail closed on any option that could alter the effective command scope
    // (explicit args, unparsed args, an unrecognized forwarded option) before
    // crediting the project root.
    if (!hasOnlyScopeSafeOptions(options)) {
      continue;
    }
    const invoked = invokedCommand(options);
    if (invoked === undefined) {
      continue;
    }
    // Every project.json in this repository declares a `root` that equals its
    // own directory; using the path directory keeps the loader unchanged and
    // the value identical.
    const root = path.dirname(file.path);
    if (!isProjectWideOxlintScope(invoked, root)) {
      continue;
    }
    projects.push({ name: file.name, root });
  }
  projects.sort((left, right) => left.name.localeCompare(right.name));
  return projects;
}

function failedDiscovery(message: string): LintGateResult {
  return {
    biomeRuns: [],
    discoveryError: `former-root discovery failed: ${message}`,
    duplicates: [],
    failed: true,
    inventorySize: 0,
    missing: [],
    oxcExcluded: [],
    oxcRuns: [],
    surfaceGateCode: undefined,
  };
}

export async function runLintGate(
  deps: LintGateDependencies
): Promise<LintGateResult> {
  const entries = readCoverageEntries(deps.coverageDir);

  let inventory: string[];
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
    inventory = selectFormerRootFiles(
      deps.repoRoot,
      removeDeletedFiles(
        parseGitFileList(discovery.stdout),
        parseGitFileList(deletion.stdout)
      )
    );
  } catch (error: unknown) {
    return failedDiscovery(
      error instanceof Error ? error.message : String(error)
    );
  }

  const oxcProjects = discoverOxcProjects(deps.listProjectFiles(deps.repoRoot));
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
      discoveryError:
        inventory.length === 0 ? "former-root inventory is empty" : undefined,
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
    discoveryError: undefined,
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
