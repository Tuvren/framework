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
 * Detection: specifiers are extracted from a real TypeScript parse (the compiler
 * AST), not a line/regex heuristic. Only genuine module-specifier positions are
 * inspected — static `import`/`export ... from`, side-effect `import "x"`,
 * `import x = require("x")`, and dynamic `import("x")`/`require("x")` calls —
 * so a package name that merely appears inside a string literal (e.g. a
 * `runtimeVersion: "@tuvren/runtime@0.0.0"` transcript payload or an
 * `import ... from "@tuvren/runtime"` example rendered as demo text) or inside a
 * comment is never mistaken for an import, and a real import can never be hidden
 * from the gate by an adjacent string/comment or by line-wrapping. Both
 * quoted-string and no-substitution-template (`` `@tuvren/kernel-runtime` ``)
 * specifiers are covered. The gate is deliberately narrowed to
 * `typescript/host/**`; documentation code examples are out of scope for this
 * epic (KRT-BJ003 STOP condition), with the known drift in
 * `spec/host/client-endpoint-integration.md` recorded as a follow-up in the epic
 * file rather than enforced here.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface HostBoundaryViolation {
  line: number;
  relativePath: string;
  specifier: string;
}

interface FoundSpecifier {
  line: number;
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

    for (const found of extractForbiddenImports(content, filePath)) {
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
  content: string,
  fileName: string
): FoundSpecifier[] {
  // Parse with parent nodes populated so `getStart` resolves leading trivia;
  // the ScriptKind only distinguishes JSX so import extraction is unaffected by
  // .mts/.cts/.d.ts variants.
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );
  const results: FoundSpecifier[] = [];

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== undefined && isForbidden(specifier.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        specifier.node.getStart(sourceFile)
      );
      results.push({ line: line + 1, specifier: specifier.text });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}

// Resolve the module specifier a node imports, or `undefined` if the node is
// not an import position (or its specifier is not statically known — e.g. a
// `${...}` template, which cannot be a compile-time module specifier).
function moduleSpecifierOf(
  node: ts.Node
): { node: ts.Node; text: string } | undefined {
  // Static `import ... from "x"`, `export ... from "x"`, and side-effect
  // `import "x"`. `export { x }` with no `from` has no moduleSpecifier.
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return staticSpecifier(node.moduleSpecifier);
  }
  // `import x = require("x")`
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return staticSpecifier(node.moduleReference.expression);
  }
  // Dynamic `import("x")` and `require("x")`.
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
    const isRequireCall = ts.isIdentifier(callee) && callee.text === "require";
    if (isImportCall || isRequireCall) {
      return staticSpecifier(node.arguments[0]);
    }
  }
  return undefined;
}

function staticSpecifier(
  node: ts.Expression | undefined
): { node: ts.Node; text: string } | undefined {
  // `isStringLiteralLike` accepts both quoted strings ("x"/'x') and
  // no-substitution templates (`x`); a TemplateExpression with substitutions is
  // deliberately excluded because its value is not statically resolvable.
  if (node !== undefined && ts.isStringLiteralLike(node)) {
    return { node, text: node.text };
  }
  return undefined;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
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
