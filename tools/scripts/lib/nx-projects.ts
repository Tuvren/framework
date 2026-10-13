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

/**
 * Shared filesystem-walk index of the repo's Nx `project.json` files, used by
 * the discovery-style parity gates (certification discovery, workspace
 * test-lane coverage). Reads the working tree directly — no Nx daemon — so
 * gates stay sub-second and see unstaged state. Projects declared without a
 * `project.json` would be invisible; this repo defines every Nx project
 * through `project.json`.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// nx:run-commands accepts a single `command` string or a `commands` array
// whose entries are strings or `{ command: string, ... }` objects; gates
// that inspect command text must scan both shapes — and `configurations`
// overrides, which carry the same dual shape per configuration name.
export interface NxCommandOptions {
  command?: string;
  commands?: (string | { command?: string })[];
  cwd?: string;
  // `nx:run-commands` appends these to the executed command
  // (normalizeOptions + interpolateArgsIntoCommand). They are declared so the
  // lint-scope gate can reject any invocation whose effective scope differs
  // from its literal command text instead of crediting the project root.
  args?: string | string[];
  __unparsed__?: string[];
  forwardAllArgs?: boolean;
  /**
   * Nx forwards every unrecognized scalar option as `--<key>=<value>` on the
   * executed command, so the scope gate treats an extra key as
   * scope-affecting and refuses whole-root credit.
   */
  [option: string]: unknown;
}

export interface NxProjectTarget {
  configurations?: Record<string, Record<string, unknown>>;
  // Nx selects this configuration for an unqualified `nx run project:target`
  // (create-task-graph resolveConfiguration). Gates that model the invoked
  // command must apply it, not every named configuration.
  defaultConfiguration?: string;
  // The executor that actually runs the target. Only `nx:run-commands` appends
  // forwarded args; a custom executor that merely accepts a command-shaped
  // `options` object must never earn lint coverage.
  executor?: string;
  // Executor-specific fields are opaque until a consumer selects an executor.
  options?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry: unknown) => typeof entry === "string");

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const COMMAND_COLORS = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
]);

const COMMAND_BACKGROUND_COLORS = new Set([
  "bgBlack",
  "bgRed",
  "bgGreen",
  "bgYellow",
  "bgBlue",
  "bgMagenta",
  "bgCyan",
  "bgWhite",
]);

const isRunCommandEntry = (value: unknown): boolean => {
  if (typeof value === "string") {
    return true;
  }
  if (!isRecord(value) || typeof value.command !== "string") {
    return false;
  }
  return Object.entries(value).every(([key, field]) => {
    switch (key) {
      case "command":
      case "prefix":
      case "description": {
        return typeof field === "string";
      }
      case "forwardAllArgs": {
        return typeof field === "boolean";
      }
      case "color":
      case "prefixColor": {
        return typeof field === "string" && COMMAND_COLORS.has(field);
      }
      case "bgColor": {
        return (
          typeof field === "string" && COMMAND_BACKGROUND_COLORS.has(field)
        );
      }
      default: {
        return false;
      }
    }
  });
};

// Validate the complete installed run-commands field surface after executor
// selection. Partial configuration fragments need not contain a command;
// unknown top-level fields remain opaque. Tests pin this boundary to Nx's
// schema without importing its runtime validator into filesystem discovery.
const isCanonicalCommandOptions = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, "command") && Object.hasOwn(value, "commands")) {
    return false;
  }
  return Object.entries(value).every(([key, field]) => {
    if (field === undefined) {
      return true;
    }
    switch (key) {
      case "command":
      case "readyWhen":
      case "args": {
        return typeof field === "string" || isStringArray(field);
      }
      case "commands": {
        return Array.isArray(field) && field.every(isRunCommandEntry);
      }
      case "parallel":
      case "color":
      case "forwardAllArgs":
      case "tty": {
        return typeof field === "boolean";
      }
      case "envFile":
      case "cwd": {
        return typeof field === "string";
      }
      case "env": {
        return (
          isRecord(field) &&
          Object.values(field).every((entry) => typeof entry === "string")
        );
      }
      case "__unparsed__": {
        return isStringArray(field);
      }
      default: {
        return true;
      }
    }
  });
};

/**
 * Supported literal command inventory for an nx:run-commands target: the base
 * `options` (single `command` string or `commands` array of strings /
 * `{ command }` objects) plus every named `configurations` override.
 * Gates that back-check command text (certification discovery, workspace
 * test-lane coverage) must scan all of these, or a target rewritten in an
 * equally-valid alternate shape silently escapes the gate. This inventories
 * text; it does not prove successful execution or normalize runtime
 * interpolation, arguments, or shell tokens.
 */
export const targetCommandStrings = (target: NxProjectTarget): string[] => {
  if (target.executor !== "nx:run-commands") {
    return [];
  }
  const configurations = Object.values(target.configurations ?? {});
  if (
    (target.options !== undefined &&
      !isCanonicalCommandOptions(target.options)) ||
    configurations.some(
      (configuration) =>
        !isCanonicalCommandOptions({ ...target.options, ...configuration })
    )
  ) {
    return [];
  }
  const out: string[] = [];
  const collect = (options: Record<string, unknown> | undefined): boolean => {
    if (options === undefined) {
      return true;
    }
    if (typeof options.command === "string") {
      out.push(options.command);
      return !Object.hasOwn(options, "commands");
    }
    if (Object.hasOwn(options, "command")) {
      return false;
    }
    if (!Object.hasOwn(options, "commands")) {
      return true;
    }
    if (!Array.isArray(options.commands)) {
      return false;
    }
    const entries: unknown[] = options.commands;
    for (const entry of entries) {
      if (typeof entry === "string") {
        out.push(entry);
        continue;
      }
      if (!isRecord(entry) || typeof entry.command !== "string") {
        return false;
      }
      out.push(entry.command);
    }
    return true;
  };
  if (!collect(target.options)) {
    return [];
  }
  for (const configuration of configurations) {
    if (!collect(configuration)) {
      return [];
    }
  }
  return out;
};

export interface NxProjectJson {
  name?: string;
  tags?: string[];
  targets?: Record<string, NxProjectTarget>;
}

export interface NxProjectFile {
  /** Nx project name (files without a string `name` are skipped). */
  name: string;
  /** `project.json` path relative to the walk root. */
  path: string;
  /** Parsed `project.json` content. */
  project: NxProjectJson;
}

const isNxProjectTarget = (value: unknown): value is NxProjectTarget => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOptionalString(value.executor) &&
    isOptionalString(value.defaultConfiguration) &&
    (value.options === undefined || isRecord(value.options)) &&
    (value.configurations === undefined ||
      (isRecord(value.configurations) &&
        Object.values(value.configurations).every(isRecord)))
  );
};

const isNxProjectJson = (value: unknown): value is NxProjectJson => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOptionalString(value.name) &&
    (value.tags === undefined || isStringArray(value.tags)) &&
    (value.targets === undefined ||
      (isRecord(value.targets) &&
        Object.values(value.targets).every(isNxProjectTarget)))
  );
};

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

const findProjectFiles = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Plain directories only: symlinked dirs (e.g. the root bazel-* links)
    // report isDirectory() === false on the Dirent and are skipped.
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      findProjectFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name === "project.json") {
      out.push(path.join(dir, entry.name));
    }
  }
};

export const loadNxProjectFiles = (root: string): NxProjectFile[] => {
  const files: string[] = [];
  findProjectFiles(root, files);
  const records: NxProjectFile[] = [];
  for (const absolute of files) {
    const relativePath = path.relative(root, absolute);
    let project: unknown;
    try {
      project = JSON.parse(readFileSync(absolute, "utf-8"));
    } catch (error: unknown) {
      throw new Error(
        `unparseable project.json at ${relativePath}: ${String(error)}`,
        { cause: error }
      );
    }
    // Nx would infer a name from the directory here, but the discovery
    // gates built on this index (certification parity, test-lane coverage)
    // exist to hard-fail instead of silently narrowing — a live project
    // this loader cannot index would escape both. Fail loud.
    if (!isRecord(project) || typeof project.name !== "string") {
      throw new TypeError(
        `project.json without a string name at ${relativePath} — the discovery gates cannot index it; add an explicit name`
      );
    }
    const { name } = project;
    if (!isNxProjectJson(project)) {
      throw new TypeError(`invalid project.json fields at ${relativePath}`);
    }
    records.push({ name, path: relativePath, project });
  }
  return records;
};
