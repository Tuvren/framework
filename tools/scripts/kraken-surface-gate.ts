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

// Public-surface Kraken-naming guard (KRT-BM008). The repo rule reserves
// Kraken* names for engine internals: ordinary library consumers must never
// type a Kraken*-named symbol. The audit found the public surface clean
// today; this gate keeps that permanent instead of incidental by failing
// loud if any workspace package's public entrypoint exports a symbol whose
// name contains "Kraken".
//
// Entry files are resolved from each package.json `exports` map by the
// repo's source-layout convention (dist/<x>/index.js -> src/<x>/index.ts,
// dist/<x>.js -> src/<x>.ts). Only export statements are inspected, so
// importing a Kraken*-named engine internal and re-exporting it under a
// clean name stays legal; `export *` is rejected outright because a
// wildcard surface cannot be verified name-by-name (repo rule: keep
// package entrypoints small and explicit).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const WORKSPACE_GLOBS: readonly string[] = JSON.parse(
  readFileSync("package.json", "utf8")
).workspaces;

interface Violation {
  entry: string;
  exportedName: string;
  packageName: string;
}

function resolveWorkspaceDirs(): string[] {
  const dirs: string[] = [];

  for (const glob of WORKSPACE_GLOBS) {
    if (!glob.endsWith("/*")) {
      throw new Error(
        `kraken-surface-gate: unsupported workspace glob "${glob}" — extend the resolver`
      );
    }

    const parent = glob.slice(0, -2);

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(join(parent, entry.name, "package.json"))
      ) {
        dirs.push(join(parent, entry.name));
      }
    }
  }

  return dirs;
}

// Maps a package.json exports entry to its source-layout counterpart.
function sourceCandidatesForExport(subpath: string): string[] {
  const relative =
    subpath === "." ? "index" : subpath.replace(SUBPATH_PREFIX, "");
  return [`src/${relative}.ts`, `src/${relative}/index.ts`];
}

function collectEntryFiles(packageDir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  );
  const subpaths = Object.keys(manifest.exports ?? { ".": true });
  const entries: string[] = [];

  for (const subpath of subpaths) {
    if (!subpath.startsWith(".")) {
      continue;
    }

    const candidate = sourceCandidatesForExport(subpath).find((relativePath) =>
      existsSync(join(packageDir, relativePath))
    );

    if (candidate !== undefined) {
      entries.push(join(packageDir, candidate));
    }
  }

  return entries;
}

const SUBPATH_PREFIX = /^\.\//;
const TYPE_PREFIX = /^\s*type\s+/;
const RENAMED_EXPORT = /\bas\s+([A-Za-z_$][\w$]*)\s*$/;
const WHITESPACE = /\s+/;
const NAMED_EXPORT_BLOCK = /export\s+(?:type\s+)?\{([^}]*)\}/g;
const DECLARATION_EXPORT =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const WILDCARD_EXPORT = /export\s+\*\s+from/;

function exportedNames(source: string): string[] {
  const names: string[] = [];

  for (const match of source.matchAll(NAMED_EXPORT_BLOCK)) {
    const items = (match[1] ?? "").split(",");

    for (const item of items) {
      const trimmed = item.replace(TYPE_PREFIX, "").trim();

      if (trimmed.length === 0) {
        continue;
      }

      const asMatch = trimmed.match(RENAMED_EXPORT);
      names.push(asMatch?.[1] ?? trimmed.split(WHITESPACE)[0] ?? trimmed);
    }
  }

  for (const match of source.matchAll(DECLARATION_EXPORT)) {
    const name = match[1];

    if (name !== undefined) {
      names.push(name);
    }
  }

  return names;
}

const violations: Violation[] = [];
let scannedEntries = 0;

for (const packageDir of resolveWorkspaceDirs()) {
  const packageName = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  ).name;

  for (const entry of collectEntryFiles(packageDir)) {
    const source = readFileSync(entry, "utf8");
    scannedEntries += 1;

    if (WILDCARD_EXPORT.test(source)) {
      violations.push({
        entry,
        exportedName:
          "export * (wildcard surfaces cannot be verified name-by-name)",
        packageName,
      });
      continue;
    }

    for (const name of exportedNames(source)) {
      if (name.includes("Kraken")) {
        violations.push({ entry, exportedName: name, packageName });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "kraken-surface-gate: Kraken*-named symbols leaked into public package surfaces:"
  );

  for (const violation of violations) {
    console.error(
      `- ${violation.packageName} (${violation.entry}): ${violation.exportedName}`
    );
  }

  console.error(
    "Kraken* names are engine-internal only; export the underlying public name instead."
  );
  process.exit(1);
}

console.log(
  `kraken-surface-gate: ${scannedEntries} public entrypoints clean — no Kraken*-named exports`
);
