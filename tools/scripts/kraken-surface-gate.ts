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

  // No exports map and no src entry barrel: the package declares no public
  // source surface to guard (the certification wrapper projects). Anything
  // with an explicit exports map must resolve every subpath, below.
  if (
    manifest.exports === undefined &&
    !existsSync(join(packageDir, "src/index.ts"))
  ) {
    return [];
  }

  // A string-form or conditions-only exports map ("exports": "./dist/x.js",
  // or an object with only condition keys like "import"/"types") yields zero
  // dot subpaths and would leave the whole package unscanned while still
  // counting as "checked" — fail loud instead, mirroring the unresolvable-
  // subpath branch below.
  if (
    manifest.exports !== undefined &&
    (typeof manifest.exports !== "object" ||
      manifest.exports === null ||
      !Object.keys(manifest.exports).some((key) => key.startsWith(".")))
  ) {
    throw new Error(
      `kraken-surface-gate: ${packageDir} declares an "exports" form with no "." subpaths (string shorthand or conditions-only object) — the resolver cannot map it to source entries and the package would go unscanned; use dot-subpath exports or extend the resolver`
    );
  }

  const subpaths = Object.keys(manifest.exports ?? { ".": true });
  const entries: string[] = [];

  for (const subpath of subpaths) {
    if (!subpath.startsWith(".")) {
      continue;
    }

    const candidate = sourceCandidatesForExport(subpath).find((relativePath) =>
      existsSync(join(packageDir, relativePath))
    );

    // Fail loud instead of silently skipping: a subpath this resolver cannot
    // map to a source file would otherwise become an unscanned public
    // surface, which reads as "verified clean" when it was never looked at.
    if (candidate === undefined) {
      throw new Error(
        `kraken-surface-gate: ${packageDir} exports subpath "${subpath}" but no source entry exists at the conventional locations (${sourceCandidatesForExport(subpath).join(", ")}) — extend sourceCandidatesForExport`
      );
    }

    entries.push(join(packageDir, candidate));
  }

  return entries;
}

const SUBPATH_PREFIX = /^\.\//;
const TYPE_PREFIX = /^\s*type\s+/;
const RENAMED_EXPORT = /\bas\s+([A-Za-z_$][\w$]*)\s*$/;
const WHITESPACE = /\s+/;
const NAMED_EXPORT_BLOCK = /export\s+(?:type\s+)?\{([^}]*)\}/g;
// Single-name declaration forms only; `const`/`let`/`var` go through the
// declarator scanner below because one statement can bind several names
// (`export const a = 1, KrakenB = 2;`). `const\s+enum` stays here so the
// capture lands on the enum's name; `namespace`/`module` bind a public
// namespace name just like a class or enum does.
const DECLARATION_EXPORT =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|function\*?|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/g;
const VARIABLE_EXPORT = /export\s+(?:declare\s+)?(?:const|let|var)\s+/g;
const CONST_ENUM_TAIL = /^enum\s/;
const LEADING_IDENTIFIER = /^\s*([A-Za-z_$][\w$]*)/;
// Any `export *` form is unverifiable name-by-name — including the ES2020
// namespace re-export `export * as Ns from`, which would otherwise slip a
// (possibly Kraken*-named) namespace binding past both extraction branches.
const WILDCARD_EXPORT = /export\s+\*/;

function skipStringLiteral(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];

    if (char === "\\") {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }

  return index;
}

// Splits the declarator list of an `export const/let/var` statement at
// top-level commas (commas inside initializer parens/brackets/braces or
// string literals do not separate declarators), stopping at the top-level
// semicolon that ends the statement.
function splitTopLevelDeclarators(source: string, start: number): string[] {
  const segments: string[] = [];
  let depth = 0;
  let segmentStart = start;
  let index = start;

  while (index < source.length) {
    const char = source[index];

    if (char === '"' || char === "'" || char === "`") {
      index = skipStringLiteral(source, index);
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (depth === 0 && char === ",") {
      segments.push(source.slice(segmentStart, index));
      segmentStart = index + 1;
    } else if (depth === 0 && char === ";") {
      break;
    }

    index += 1;
  }

  segments.push(source.slice(segmentStart, index));
  return segments;
}

function variableExportNames(source: string, entry: string): string[] {
  const names: string[] = [];

  for (const match of source.matchAll(VARIABLE_EXPORT)) {
    const start = match.index + match[0].length;

    // `export const enum X` is a single-name declaration handled by
    // DECLARATION_EXPORT, not a variable declarator list.
    if (CONST_ENUM_TAIL.test(source.slice(start))) {
      continue;
    }

    for (const segment of splitTopLevelDeclarators(source, start)) {
      const name = segment.match(LEADING_IDENTIFIER)?.[1];

      // Destructuring or otherwise unnameable declarators cannot be verified
      // name-by-name — reject them the same way `export *` is rejected.
      if (name === undefined) {
        throw new Error(
          `kraken-surface-gate: ${entry} exports a variable declarator this scanner cannot name ("${segment.trim().slice(0, 60)}") — destructuring export patterns cannot be verified name-by-name; export named bindings explicitly`
        );
      }

      names.push(name);
    }
  }

  return names;
}

function exportedNames(source: string, entry: string): string[] {
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

  names.push(...variableExportNames(source, entry));

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

    for (const name of exportedNames(source, entry)) {
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
