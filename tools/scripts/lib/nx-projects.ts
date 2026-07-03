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
import { join, relative } from "node:path";

export interface NxProjectTarget {
  options?: {
    command?: string;
    // nx:run-commands also accepts a `commands` array whose entries are
    // strings or `{ command: string, ... }` objects; gates that inspect
    // command text must scan both shapes.
    commands?: (string | { command?: string })[];
  };
}

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

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

function findProjectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Plain directories only: symlinked dirs (e.g. the root bazel-* links)
    // report isDirectory() === false on the Dirent and are skipped.
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      findProjectFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name === "project.json") {
      out.push(join(dir, entry.name));
    }
  }
}

export function loadNxProjectFiles(root: string): NxProjectFile[] {
  const files: string[] = [];
  findProjectFiles(root, files);
  const records: NxProjectFile[] = [];
  for (const absolute of files) {
    const path = relative(root, absolute);
    let project: NxProjectJson;
    try {
      project = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new Error(`unparseable project.json at ${path}: ${error}`);
    }
    if (typeof project.name !== "string") {
      continue;
    }
    records.push({ name: project.name, path, project });
  }
  return records;
}
