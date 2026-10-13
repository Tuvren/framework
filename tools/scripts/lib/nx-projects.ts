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

/**
 * Every command string an nx:run-commands target can execute: the base
 * `options` (single `command` string or `commands` array of strings /
 * `{ command }` objects) plus every named `configurations` override.
 * Gates that back-check command text (certification discovery, workspace
 * test-lane coverage) must scan all of these, or a target rewritten in an
 * equally-valid alternate shape silently escapes the gate.
 */
export const targetCommandStrings = (target: NxProjectTarget): string[] => {
  const out: string[] = [];
  const collect = (options: Record<string, unknown> | undefined): void => {
    if (typeof options?.command === "string") {
      out.push(options.command);
    }
    if (!Array.isArray(options?.commands)) {
      return;
    }
    const entries: unknown[] = options.commands;
    for (const entry of entries) {
      if (typeof entry === "string") {
        out.push(entry);
      } else if (isRecord(entry) && typeof entry.command === "string") {
        out.push(entry.command);
      }
    }
  };
  collect(target.options);
  for (const configuration of Object.values(target.configurations ?? {})) {
    collect(configuration);
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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry: unknown) => typeof entry === "string");

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

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
