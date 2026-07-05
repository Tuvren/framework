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
 *
 * ADR-057 host import boundary gate (KRT-BJ003).
 *
 * Enforces the normative host import contract from ADR-057 §3, as amended by
 * ADR-059 §3: a Tuvren host composes the runtime from the curated tier only.
 * It may import `@tuvren/core`, `@tuvren/sdk` (including the `@tuvren/sdk/advanced`
 * composition subpath added by ADR-059), and chosen leaf packages such as
 * `@tuvren/kernel-grpc-client`. It must NEVER reach past that seam into the
 * internal engine surfaces:
 *
 *   - `@tuvren/runtime`         (demoted to internal engine by ADR-057)
 *   - `@tuvren/kernel-protocol` (kernel transport wire types)
 *   - `@tuvren/kernel-runtime`  (kernel runtime construction internals)
 *
 * The gate walks `typescript/host/**` source and fails loudly when any file
 * imports one of those forbidden specifiers, naming the offending file, line,
 * and specifier. When no such import exists it passes with exit 0, and it runs
 * inside `bun run check` (inner-loop authority gate) and `bun run verify`.
 *
 * Scoping (ADR-059-aware):
 *  - `@tuvren/kernel-grpc-client` is an allowed leaf: it is neither
 *    `@tuvren/kernel-runtime` nor a subpath of it, so the prefix rule below
 *    passes it through by construction.
 *  - `@tuvren/sdk/advanced` is an allowed curated subpath: it is not in the
 *    forbidden set, so it passes through as well.
 *
 * Detection scope: this gate matches module SPECIFIERS in import / export-from /
 * dynamic-import / require positions after stripping comments, so it does not
 * false-positive on transcript payload strings such as
 * `runtimeVersion: "@tuvren/runtime@0.0.0"`, which are not import specifiers.
 * It is deliberately narrowed to `typescript/host/**`; documentation code
 * examples are out of scope for this epic (KRT-BJ003 STOP condition — no doc
 * example currently imports a forbidden specifier).
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface HostBoundaryViolation {
  line: number;
  relativePath: string;
  specifier: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_ROOT = resolve(REPO_ROOT, "typescript/host");

// Engine-tier specifiers a host must never import directly (ADR-057 §3,
// ADR-059 §3). A specifier violates the boundary when it equals one of these
// exactly or is a subpath of it (`<pkg>/...`). The prefix form is what keeps
// the allowed `@tuvren/kernel-grpc-client` leaf from colliding with the
// forbidden `@tuvren/kernel-runtime` engine package.
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  "@tuvren/runtime",
  "@tuvren/kernel-protocol",
  "@tuvren/kernel-runtime",
];

// Source extensions to scan. `.d.ts` is covered by the `.ts` suffix test; a
// declaration file that reached across the seam would be just as much of a
// violation as runtime source.
const SCANNABLE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

// Derived/vendored trees never carry the authored host boundary and would only
// add noise (or generated re-exports); skip them during the walk.
const SKIP_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "generated",
  "coverage",
]);

// Module specifier in an import / export-from / dynamic-import / require
// position. Requiring the `from` / `import` / `require` keyword immediately
// before the quoted string is what excludes bare data strings that merely
// contain a package name.
const MODULE_SPECIFIER_PATTERN =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?:"([^"]+)"|'([^']+)')/g;

// Line splitter, hoisted to module scope per the `useTopLevelRegex` lint floor.
const LINE_SPLIT_PATTERN = /\r?\n/u;

await main();

async function main(): Promise<void> {
  if (!existsSync(HOST_ROOT)) {
    console.error(
      `host import boundary gate failed: host root not found at ${relative(REPO_ROOT, HOST_ROOT)}`
    );
    process.exitCode = 1;
    return;
  }

  const files = await findScannableFiles(HOST_ROOT);

  if (files.length === 0) {
    console.error(
      `host import boundary gate failed: no host source files found under ${relative(REPO_ROOT, HOST_ROOT)}`
    );
    process.exitCode = 1;
    return;
  }

  const violations: HostBoundaryViolation[] = [];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const relativePath = relative(REPO_ROOT, filePath);

    for (const found of extractForbiddenImports(content)) {
      violations.push({
        line: found.line,
        relativePath,
        specifier: found.specifier,
      });
    }
  }

  if (violations.length > 0) {
    console.error("host import boundary gate failed (ADR-057 §3, ADR-059 §3):");
    for (const violation of violations) {
      console.error(
        `  [host-import-boundary] ${violation.relativePath}:${violation.line} imports forbidden engine specifier "${violation.specifier}"`
      );
    }
    console.error(
      "  hosts must compose from @tuvren/core, @tuvren/sdk (incl. @tuvren/sdk/advanced), and leaf packages only"
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `host import boundary gate passed (${files.length} host source files scanned under ${relative(REPO_ROOT, HOST_ROOT)})`
  );
}

function extractForbiddenImports(
  content: string
): Array<{ line: number; specifier: string }> {
  const results: Array<{ line: number; specifier: string }> = [];
  const lines = content.split(LINE_SPLIT_PATTERN);
  let insideBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripCommentsFromLine(lines[index], insideBlockComment);
    insideBlockComment = stripped.stillInsideBlockComment;

    if (stripped.code.trim() === "") {
      continue;
    }

    for (const specifier of extractModuleSpecifiers(stripped.code)) {
      if (isForbidden(specifier)) {
        results.push({ line: index + 1, specifier });
      }
    }
  }

  return results;
}

// Remove `//` line comments and `/* ... */` block comments from a single line
// while carrying block-comment state across lines, so a doc comment that
// mentions `from "@tuvren/runtime"` in prose cannot be mistaken for an import.
// String-literal contents are intentionally not parsed: import specifiers never
// contain `//` or `/*`, and the host tree carries no import-example strings.
function stripCommentsFromLine(
  line: string,
  insideBlockComment: boolean
): { code: string; stillInsideBlockComment: boolean } {
  let code = "";
  let cursor = 0;
  let insideBlock = insideBlockComment;

  while (cursor < line.length) {
    if (insideBlock) {
      const end = line.indexOf("*/", cursor);
      if (end === -1) {
        return { code, stillInsideBlockComment: true };
      }
      cursor = end + 2;
      insideBlock = false;
      continue;
    }

    const pair = line.slice(cursor, cursor + 2);
    if (pair === "//") {
      break;
    }
    if (pair === "/*") {
      insideBlock = true;
      cursor += 2;
      continue;
    }

    code += line[cursor];
    cursor += 1;
  }

  return { code, stillInsideBlockComment: insideBlock };
}

function extractModuleSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  MODULE_SPECIFIER_PATTERN.lastIndex = 0;
  let match = MODULE_SPECIFIER_PATTERN.exec(code);

  while (match !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    match = MODULE_SPECIFIER_PATTERN.exec(code);
  }

  return specifiers;
}

function isForbidden(specifier: string): boolean {
  return FORBIDDEN_SPECIFIERS.some(
    (forbidden) =>
      specifier === forbidden || specifier.startsWith(`${forbidden}/`)
  );
}

async function findScannableFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (
        SKIP_DIRECTORY_NAMES.has(entry.name) ||
        entry.name.startsWith(".tmp")
      ) {
        continue;
      }
      paths.push(...(await findScannableFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && isScannable(entry.name)) {
      paths.push(entryPath);
    }
  }

  return paths.sort();
}

function isScannable(fileName: string): boolean {
  return SCANNABLE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}
