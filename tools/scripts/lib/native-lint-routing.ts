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

import path from "node:path";

import type { RunCommandResult } from "./command-runner.js";
import { isCodeFile } from "./json-source-integrity.js";
import type {
  NxCommandOptions,
  NxProjectFile,
  NxProjectTarget,
} from "./nx-projects.js";

const OXLINT_PROJECT_WIDE_COMMAND_PATTERN =
  /^bunx --bun oxlint --type-aware(?: (?<operand>\S+))?$/u;
const JSON_CHECK_PROJECT_WIDE_COMMAND_PATTERN =
  /^bun tools\/scripts\/json-check\.ts(?: (?<operand>\S+))$/u;
const JSON_ONLY_PROJECT_WIDE_COMMAND_PATTERN =
  /^bun tools\/scripts\/json-check\.ts --json-only(?: (?<operand>\S+))$/u;
const GLOB_METACHARACTER_PATTERN = /[*?[\]{}]/u;
const BACKSLASH_PATTERN = /\\/gu;
const TRAILING_SLASH_PATTERN = /\/+$/u;
const LINE_PATTERN = /\r?\n/gu;
const RUN_COMMANDS_EXECUTOR = "nx:run-commands";
const SCOPE_SAFE_RUN_COMMANDS_OPTION_KEYS: ReadonlySet<string> = new Set([
  "command",
  "commands",
  "cwd",
]);

export interface OxcProject {
  jsonCompanion: boolean;
  name: string;
  root: string;
}

export interface JsonOnlyProject {
  name: string;
  root: string;
}

export interface NativeLintProjects {
  jsonOnlyProjects: JsonOnlyProject[];
  oxcProjects: OxcProject[];
}

interface InvokedLintCommands {
  commands: string[];
  cwd: string;
}

interface ClassifiedProject {
  jsonOnlyProject?: JsonOnlyProject;
  oxcProject?: OxcProject;
}

type NativePathSemantics = Pick<typeof path, "dirname" | "sep">;

export interface OxlintSelectionDependencies {
  repoRoot: string;
  runCommand: (
    command: readonly string[],
    options?: { captureOutput?: boolean; cwd?: string }
  ) => Promise<RunCommandResult>;
}

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

function hasOnlyScopeSafeOptions(options: NxCommandOptions): boolean {
  return Object.keys(options).every((key) =>
    SCOPE_SAFE_RUN_COMMANDS_OPTION_KEYS.has(key)
  );
}

function invokedCommands(
  options: NxCommandOptions
): InvokedLintCommands | undefined {
  const commands: string[] = [];
  if (typeof options.command === "string") {
    commands.push(options.command);
  } else {
    for (const entry of options.commands ?? []) {
      if (typeof entry === "string") {
        commands.push(entry);
      } else if (
        entry !== null &&
        typeof entry === "object" &&
        Object.keys(entry).length === 1 &&
        typeof entry.command === "string"
      ) {
        commands.push(entry.command);
      } else {
        return undefined;
      }
    }
  }
  if (commands.length === 0) {
    return undefined;
  }
  const cwd = options.cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    return undefined;
  }
  return { commands, cwd: cwd ?? "." };
}

function normalizeRepoRelative(value: string): string | undefined {
  const normalized = value.replace(BACKSLASH_PATTERN, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    GLOB_METACHARACTER_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  if (normalized.split("/").includes("..")) {
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

function isProjectWideScope(
  command: string,
  cwdValue: string,
  projectRoot: string,
  pattern: RegExp
): boolean {
  const match = pattern.exec(command);
  if (match === null) {
    return false;
  }
  const cwd = normalizeRepoRelative(cwdValue);
  const root = normalizeRepoRelative(projectRoot);
  if (cwd === undefined || root === undefined) {
    return false;
  }
  const operand = match.groups?.operand;
  if (operand === undefined) {
    return cwd === root;
  }
  const resolvedOperand = normalizeRepoRelative(operand);
  return (
    resolvedOperand !== undefined &&
    path.posix.normalize(path.posix.join(cwd, resolvedOperand)) === root
  );
}

function classifySingleCommand(
  file: NxProjectFile,
  invoked: InvokedLintCommands,
  root: string
): ClassifiedProject | undefined {
  const command = invoked.commands[0];
  if (command === undefined) {
    return undefined;
  }
  if (
    isProjectWideScope(
      command,
      invoked.cwd,
      root,
      OXLINT_PROJECT_WIDE_COMMAND_PATTERN
    )
  ) {
    return {
      oxcProject: { jsonCompanion: false, name: file.name, root },
    };
  }
  if (
    isProjectWideScope(
      command,
      invoked.cwd,
      root,
      JSON_ONLY_PROJECT_WIDE_COMMAND_PATTERN
    )
  ) {
    return { jsonOnlyProject: { name: file.name, root } };
  }
  return undefined;
}

function classifyProject(
  file: NxProjectFile,
  pathSemantics: NativePathSemantics
): ClassifiedProject | undefined {
  const lintTarget = file.project.targets?.lint;
  if (lintTarget?.executor !== RUN_COMMANDS_EXECUTOR) {
    return undefined;
  }
  const options = selectDefaultTargetOptions(lintTarget);
  if (options === undefined || !hasOnlyScopeSafeOptions(options)) {
    return undefined;
  }
  const invoked = invokedCommands(options);
  if (invoked === undefined) {
    return undefined;
  }
  const nativeRoot = pathSemantics.dirname(file.path);
  // Repository inventory and Oxlint debug output use slash-separated paths.
  // Convert only native Windows separators so POSIX backslashes remain data.
  const root =
    pathSemantics.sep === path.win32.sep
      ? nativeRoot.replace(BACKSLASH_PATTERN, "/")
      : nativeRoot;
  if (invoked.commands.length === 1) {
    return classifySingleCommand(file, invoked, root);
  }
  if (invoked.commands.length !== 2) {
    return undefined;
  }
  const [oxlintCommand, jsonCommand] = invoked.commands;
  const validComposite =
    oxlintCommand !== undefined &&
    jsonCommand !== undefined &&
    isProjectWideScope(
      oxlintCommand,
      invoked.cwd,
      root,
      OXLINT_PROJECT_WIDE_COMMAND_PATTERN
    ) &&
    isProjectWideScope(
      jsonCommand,
      invoked.cwd,
      root,
      JSON_CHECK_PROJECT_WIDE_COMMAND_PATTERN
    );
  if (!validComposite) {
    return undefined;
  }
  return { oxcProject: { jsonCompanion: true, name: file.name, root } };
}

export function discoverNativeLintProjects(
  projectFiles: readonly NxProjectFile[],
  pathSemantics: NativePathSemantics = path
): NativeLintProjects {
  const jsonOnlyProjects: JsonOnlyProject[] = [];
  const oxcProjects: OxcProject[] = [];
  for (const file of projectFiles) {
    const classified = classifyProject(file, pathSemantics);
    if (classified?.jsonOnlyProject !== undefined) {
      jsonOnlyProjects.push(classified.jsonOnlyProject);
    }
    if (classified?.oxcProject !== undefined) {
      oxcProjects.push(classified.oxcProject);
    }
  }
  jsonOnlyProjects.sort((left, right) => left.name.localeCompare(right.name));
  oxcProjects.sort((left, right) => left.name.localeCompare(right.name));
  return { jsonOnlyProjects, oxcProjects };
}

export function discoverOxcProjects(
  projectFiles: readonly NxProjectFile[],
  pathSemantics: NativePathSemantics = path
): OxcProject[] {
  return discoverNativeLintProjects(projectFiles, pathSemantics).oxcProjects;
}

function parseOxlintSelectedFiles(stdout: string): string[] {
  return stdout
    .split(LINE_PATTERN)
    .map((line) => line.trim().replace(BACKSLASH_PATTERN, "/"))
    .filter((line) => line.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export async function collectOxlintSelectedFiles(
  projects: readonly OxcProject[],
  deps: OxlintSelectionDependencies
): Promise<string[]> {
  const selected: string[] = [];
  for (const project of projects) {
    const result = await deps.runCommand(
      [
        "bunx",
        "--bun",
        "oxlint",
        "--type-aware",
        project.root,
        "--debug=files",
      ],
      { captureOutput: true, cwd: deps.repoRoot }
    );
    if (result.code !== 0) {
      throw new Error(
        `Oxlint file selection for ${project.name} exited with code ${result.code}`
      );
    }
    const files = parseOxlintSelectedFiles(result.stdout);
    if (files.length === 0) {
      throw new Error(`Oxlint file selection for ${project.name} is empty`);
    }
    if (
      files.some((file) => !(isWithin(file, project.root) && isCodeFile(file)))
    ) {
      throw new Error(
        `Oxlint file selection for ${project.name} escaped its supported code scope`
      );
    }
    selected.push(...files);
  }
  return selected;
}

function isWithin(file: string, candidate: string): boolean {
  return file === candidate || file.startsWith(`${candidate}/`);
}
