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

// KRT-BL002 (ADR-054, ADR-056, ADR-057): the API-surface snapshot / freeze
// gate. Extracts the public surface of the freeze targets — `@tuvren/core`
// (root + every export-map subpath) and `@tuvren/sdk` (root) — with the
// TypeScript compiler API, classifies each export as stable or `@experimental`
// from its TSDoc release tag, and diffs the result against the committed
// snapshot under tools/scripts/__snapshots__/api-surface/ using the ADR-056
// diff table (implemented and self-tested in ./lib/api-freeze-model.ts).
//
// Tool choice (ADR-056 left it to execution): a custom source-barrel walker,
// NOT api-extractor. The KRT-BJ006 review proved the `@experimental` tags live
// on the barrel re-export statements (typescript/core/src/capabilities/
// index.ts), while api-extractor reads release tags from a symbol's canonical
// declaration and would classify all 22 capability exports as untagged —
// tripping the consistency floor or silently promoting them to stable. This
// walker reads tags from the barrel statement first and the resolved
// declaration second, so either placement counts.
//
// `@tuvren/runtime` is never snapshotted (ADR-057 item 5: internal engine,
// not semver-guaranteed). `@tuvren/sdk`'s `./advanced` subpath (ADR-059
// escape hatch) and the leaf packages are outside the snapshot per the
// KRT-BL001 freeze-candidate record (.constitution/reports/
// krt-bl001-freeze-candidate-audit.md §3).
//
// Modes:
//   --check   (gate; wired into `bun run check` / `bun run verify`): fails on
//             any drift from the committed snapshot. Blocked drift explains
//             the ADR-056 rule it violates; allowed drift instructs the
//             operator to record it with `bun run api-freeze`.
//   --update  (write; root script `api-freeze`): refreshes the snapshot.
//             Refuses blocked drift unless --major declares the semver-major.
//   --update --major: additionally absorbs blocked (breaking) drift, recording
//             the bump class in the snapshot ledger.
//
// Known limitation (shared with api-extractor-class reports): the signature
// captured per export is the resolved declaration text of the export itself.
// A shape change in a referenced type is caught when that type is itself
// exported from an audited entrypoint (true for the audited surface today);
// a non-exported referenced type would be a blind spot.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import {
  type ApiSurface,
  classifySurfaceDiff,
  type DiffFinding,
  type EntrypointSurface,
  type ExportRecord,
  runDiffTableSelfTest,
  type SurfaceDiff,
} from "./lib/api-freeze-model.js";
import { walkPackageManifests } from "./lib/walk-package-manifests.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../");
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "tools/scripts/__snapshots__/api-surface/api-surface-snapshot.json"
);
const CORE_PACKAGE_DIR = "typescript/core";
const SDK_PACKAGE_DIR = "typescript/sdk";
const CORE_AUTHORITY_PACKET = path.join(
  REPO_ROOT,
  "spec/core/authority-packet.json"
);

// The authored source for the wholly-experimental declaration is the core
// authority packet's surface listing (ADR-056 decision 3; recorded by
// KRT-BJ006). The gate re-asserts the declaration is still present at run
// time so this constant cannot silently outlive the authority that backs it.
const WHOLLY_EXPERIMENTAL_ENTRYPOINTS = ["@tuvren/core/capabilities"] as const;
const AUTHORITY_DECLARATION_MARKER =
  "the /capabilities subpath is declared wholly experimental";
const DIST_PREFIX_PATTERN = /^\.\/dist\//;
const DECLARATION_SUFFIX_PATTERN = /\.d\.ts$/;
const WHITESPACE_RUN_PATTERN = /\s+/g;
const WELL_KNOWN_SYMBOL_ID_PATTERN = /^(__@[^@]+)@\d+$/;

interface SnapshotFile {
  $description: string;
  authority: string[];
  entrypoints: ApiSurface;
  ledger: Array<{
    bump: string;
    changes: string[];
    recordedAt: string;
  }>;
}

interface EntrypointTarget {
  sourceFile: string;
  specifier: string;
}

function hasSymbolFlag(symbol: ts.Symbol, flag: ts.SymbolFlags): boolean {
  // biome-ignore lint/suspicious/noBitwiseOperators: ts.SymbolFlags is a bitflag enum; masking is the API's membership test.
  return (symbol.flags & flag) !== 0;
}

await main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const updateMode = args.includes("--update");
  const declaredMajor = args.includes("--major");

  if (checkMode === updateMode) {
    console.error(
      "[api-freeze-gate] pass exactly one of --check (gate) or --update (refresh snapshot)"
    );
    process.exitCode = 1;
    return;
  }

  const selfTestFailures = runDiffTableSelfTest();

  if (selfTestFailures.length > 0) {
    for (const failure of selfTestFailures) {
      console.error(
        `[api-freeze-gate] ADR-056 diff-table self-test: ${failure}`
      );
    }
    process.exitCode = 1;
    return;
  }

  await assertAuthorityDeclaration();

  const targets = await resolveEntrypointTargets();
  const live = extractSurface(targets, await buildWorkspaceSourcePaths());
  const snapshot = await readSnapshot();

  if (snapshot === undefined) {
    if (checkMode) {
      console.error(
        "[api-freeze-gate] no committed snapshot found — bootstrap the freeze baseline with `bun run api-freeze` and commit the result"
      );
      process.exitCode = 1;
      return;
    }

    await writeSnapshot(live, "baseline", ["initial freeze baseline"]);
    console.log(
      `[api-freeze-gate] wrote initial freeze baseline (${describeSurface(live)}) to ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`
    );
    return;
  }

  const diff = classifySurfaceDiff(
    snapshot.entrypoints,
    live,
    WHOLLY_EXPERIMENTAL_ENTRYPOINTS
  );

  printFindings(diff.allowed, "allowed");
  printFindings(diff.blocked, "BLOCKED");

  if (reportFloorViolations(diff)) {
    process.exitCode = 1;
    return;
  }

  if (!diff.hasDrift) {
    console.log(
      checkMode
        ? `[api-freeze-gate] frozen surface unchanged (${describeSurface(live)})`
        : "[api-freeze-gate] surface matches the committed snapshot; nothing to record"
    );
    return;
  }

  if (checkMode) {
    // ADR-056: a signature change on an @experimental export is "ALLOWED,
    // not gated" — when drift is exclusively that class, the verification
    // path stays green and the snapshot refreshes opportunistically on the
    // next `bun run api-freeze` run.
    if (diff.impliedBump === "experimental-only") {
      console.log(
        "[api-freeze-gate] experimental-only drift — not gated (ADR-056); refresh the snapshot opportunistically with `bun run api-freeze`"
      );
      return;
    }

    reportCheckModeDrift(diff);
    process.exitCode = 1;
    return;
  }

  await recordDrift(diff, live, declaredMajor);
}

/** Returns true when ADR-056 consistency-floor violations exist (never overridable). */
function reportFloorViolations(diff: SurfaceDiff): boolean {
  for (const violation of diff.floorViolations) {
    console.error(
      `[api-freeze-gate] ADR-056 consistency floor: ${violation.entrypoint} export "${violation.exportName}" lacks the @experimental tag under a subpath the authority declares wholly experimental — tag it in the barrel; this is a documentation defect, never overridable`
    );
  }

  return diff.floorViolations.length > 0;
}

function reportCheckModeDrift(diff: SurfaceDiff): void {
  if (diff.blocked.length > 0) {
    console.error(
      "[api-freeze-gate] blocked drift on the frozen surface (ADR-056). If this breaking change is intentional, declare the semver-major explicitly: `bun run api-freeze --major`, then commit the refreshed snapshot"
    );
  } else {
    console.error(
      `[api-freeze-gate] snapshot is stale: allowed drift (implied bump: ${diff.impliedBump}). Record it with \`bun run api-freeze\` and commit the refreshed snapshot`
    );
  }
}

async function recordDrift(
  diff: SurfaceDiff,
  live: ApiSurface,
  declaredMajor: boolean
): Promise<void> {
  if (diff.blocked.length > 0 && !declaredMajor) {
    console.error(
      "[api-freeze-gate] refusing to absorb blocked (breaking) drift without an explicit semver-major declaration — re-run as `bun run api-freeze --major` if the break is intentional (ADR-054 semver-major with migration window)"
    );
    process.exitCode = 1;
    return;
  }

  const bump = diff.blocked.length > 0 ? "major" : diff.impliedBump;
  const changes = [...diff.blocked, ...diff.allowed].map(
    (finding) => `${finding.entrypoint}#${finding.exportName}: ${finding.class}`
  );

  await writeSnapshot(live, bump, changes);
  console.log(
    `[api-freeze-gate] snapshot refreshed (${changes.length} change(s), recorded bump: ${bump})`
  );
}

async function assertAuthorityDeclaration(): Promise<void> {
  const packet = await readFile(CORE_AUTHORITY_PACKET, "utf8");

  if (!packet.includes(AUTHORITY_DECLARATION_MARKER)) {
    console.error(
      `[api-freeze-gate] the core authority packet no longer carries the wholly-experimental declaration for @tuvren/core/capabilities ("${AUTHORITY_DECLARATION_MARKER}") — realign WHOLLY_EXPERIMENTAL_ENTRYPOINTS in tools/scripts/api-freeze-gate.ts with the packet before running the gate`
    );
    process.exitCode = 1;
    throw new Error("authority declaration drift");
  }
}

/**
 * Derive the audited entrypoints mechanically from the freeze targets'
 * export maps (no hand-kept list): every `@tuvren/core` subpath, plus the
 * `@tuvren/sdk` root.
 */
async function resolveEntrypointTargets(): Promise<EntrypointTarget[]> {
  const targets: EntrypointTarget[] = [];

  const coreManifest = JSON.parse(
    await readFile(
      path.join(REPO_ROOT, CORE_PACKAGE_DIR, "package.json"),
      "utf8"
    )
  ) as { exports?: Record<string, unknown>; name: string };

  for (const key of Object.keys(coreManifest.exports ?? {})) {
    if (key === "./package.json") {
      continue;
    }

    const subpath = key === "." ? "" : key.slice(1); // "./errors" -> "/errors"
    targets.push({
      sourceFile: path.join(
        REPO_ROOT,
        CORE_PACKAGE_DIR,
        "src",
        key === "." ? "index.ts" : `${key.slice(2)}/index.ts`
      ),
      specifier: `${coreManifest.name}${subpath}`,
    });
  }

  // @tuvren/sdk root only: ./advanced (ADR-059 escape hatch) and the leaf
  // packages are outside the snapshot per the KRT-BL001 freeze record.
  targets.push({
    sourceFile: path.join(REPO_ROOT, SDK_PACKAGE_DIR, "src/index.ts"),
    specifier: "@tuvren/sdk",
  });

  return targets;
}

/**
 * Map every `@tuvren/*` workspace package specifier to its SOURCE entrypoint
 * (`src/.../index.ts`), derived mechanically from each package's export map by
 * rewriting `./dist/<p>/index.d.ts` → `src/<p>/index.ts`. Without this,
 * cross-package imports (e.g. `@tuvren/sdk` re-exporting from `@tuvren/core`)
 * resolve through checked-in `dist/*.d.ts` build output, and the gate would
 * see a STALE surface for any package whose dist lags its source.
 */
async function buildWorkspaceSourcePaths(): Promise<Record<string, string[]>> {
  const paths: Record<string, string[]> = {};

  for (const absoluteManifestPath of await walkPackageManifests(
    path.join(REPO_ROOT, "typescript")
  )) {
    const manifestPath = path.relative(REPO_ROOT, absoluteManifestPath);
    const manifest = JSON.parse(
      await readFile(absoluteManifestPath, "utf8")
    ) as { exports?: Record<string, { types?: string }>; name?: string };

    if (
      !manifest.name?.startsWith("@tuvren/") ||
      manifest.exports === undefined
    ) {
      continue;
    }

    const packageDir = path.dirname(manifestPath);

    for (const [key, entry] of Object.entries(manifest.exports)) {
      const types = entry?.types;

      if (typeof types !== "string" || !types.startsWith("./dist/")) {
        continue;
      }

      const sourceRelative = types
        .replace(DIST_PREFIX_PATTERN, "src/")
        .replace(DECLARATION_SUFFIX_PATTERN, ".ts");
      const specifier =
        key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`;
      paths[specifier] = [path.join(packageDir, sourceRelative)];
    }
  }

  return paths;
}

function extractSurface(
  targets: EntrypointTarget[],
  workspacePaths: Record<string, string[]>
): ApiSurface {
  const program = ts.createProgram(
    targets.map((target) => target.sourceFile),
    {
      baseUrl: REPO_ROOT,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      paths: workspacePaths,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    }
  );
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true });
  const surface: ApiSurface = {};

  for (const target of targets) {
    const sourceFile = program.getSourceFile(target.sourceFile);

    if (sourceFile === undefined) {
      throw new Error(
        `[api-freeze-gate] entrypoint source missing: ${target.sourceFile}`
      );
    }

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

    if (moduleSymbol === undefined) {
      throw new Error(
        `[api-freeze-gate] entrypoint has no module symbol (no exports?): ${target.sourceFile}`
      );
    }

    const entrySurface: EntrypointSurface = {};

    for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
      entrySurface[exportSymbol.getName()] = describeExport(
        exportSymbol,
        checker,
        printer
      );
    }

    surface[target.specifier] = sortRecord(entrySurface);
  }

  return sortRecord(surface);
}

function describeExport(
  exportSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  printer: ts.Printer
): ExportRecord {
  const resolved = hasSymbolFlag(exportSymbol, ts.SymbolFlags.Alias)
    ? checker.getAliasedSymbol(exportSymbol)
    : exportSymbol;

  const experimental =
    symbolCarriesExperimentalTag(exportSymbol) ||
    symbolCarriesExperimentalTag(resolved);

  const declarations = resolved.getDeclarations() ?? [];
  const isValue = hasSymbolFlag(resolved, ts.SymbolFlags.Value);
  const location = declarations[0];

  let signature: string;

  if (isValue && location !== undefined) {
    // Value exports (functions, consts, classes): derive the signature from
    // the CHECKER, not the printed source declaration — printing source nodes
    // would embed function/class bodies, so an internal body edit would
    // falsely trip the freeze. The checker text captures call/construct
    // signatures and typed members with inferred types resolved.
    const parts = [
      structuralTypeText(
        checker.getTypeOfSymbolAtLocation(resolved, location),
        location,
        checker
      ),
    ];

    if (hasSymbolFlag(resolved, ts.SymbolFlags.Class)) {
      parts.push(
        `instance: ${structuralTypeText(
          checker.getDeclaredTypeOfSymbol(resolved),
          location,
          checker
        )}`
      );
    }

    signature = parts.join(" ");
  } else {
    // Type exports (interfaces, type aliases): printed declaration text is
    // body-free and captures the full structural shape, including generics
    // and heritage clauses that a type-reference string would elide.
    signature = declarations
      .map((declaration) =>
        printer
          .printNode(
            ts.EmitHint.Unspecified,
            declaration,
            declaration.getSourceFile()
          )
          .replace(WHITESPACE_RUN_PATTERN, " ")
          .trim()
      )
      .sort()
      .join(" | ");
  }

  return {
    kind: isValue ? "value" : "type",
    signature,
    stability: experimental ? "experimental" : "stable",
  };
}

/**
 * Deterministic structural text for a value export's type: every call and
 * construct signature, plus — ONLY for types declared inside this repo — each
 * property with its checker-resolved type text. Types declared outside the
 * repo (primitives, lib.d.ts shapes like RegExp/Uint8Array) print via
 * `typeToString` instead of member expansion: expanding lib members embeds
 * TS-internal symbol-ID counters in well-known-symbol names (`__@iterator@49`)
 * that shift on unrelated source edits, corrupting the snapshot with false
 * blocked findings (M2 review P1). Residual well-known-symbol names from
 * in-repo types are ID-normalized for the same reason. Referenced named types
 * print by name; their own shape changes are caught at their own snapshot
 * entries (see the known limitation in the module header).
 */
function structuralTypeText(
  type: ts.Type,
  location: ts.Node,
  checker: ts.TypeChecker
): string {
  const parts: string[] = [];

  for (const callSignature of type.getCallSignatures()) {
    parts.push(
      `call ${checker.signatureToString(callSignature, location, ts.TypeFormatFlags.NoTruncation)}`
    );
  }

  for (const constructSignature of type.getConstructSignatures()) {
    parts.push(
      `new ${checker.signatureToString(constructSignature, location, ts.TypeFormatFlags.NoTruncation)}`
    );
  }

  if (typeIsDeclaredInRepo(type)) {
    const properties = checker
      .getPropertiesOfType(type)
      .map(
        (property) =>
          `${normalizeMemberName(property.getName())}: ${checker.typeToString(
            checker.getTypeOfSymbolAtLocation(property, location),
            location,
            ts.TypeFormatFlags.NoTruncation
          )}`
      )
      .sort();

    parts.push(...properties);
  }

  return parts.length > 0
    ? parts.join("; ")
    : checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation);
}

/**
 * True when the type is an object type whose symbol has a declaration inside
 * this repository (not lib.d.ts / node_modules). Non-object types (primitives,
 * unique symbols) always print via `typeToString`, never member expansion —
 * their apparent members are lib.d.ts surface, not ours.
 */
function typeIsDeclaredInRepo(type: ts.Type): boolean {
  if (!hasTypeFlag(type, ts.TypeFlags.Object)) {
    return false;
  }

  const symbol = type.getSymbol() ?? type.aliasSymbol;

  return (symbol?.getDeclarations() ?? []).some((declaration) => {
    const fileName = declaration.getSourceFile().fileName;

    return fileName.startsWith(REPO_ROOT) && !fileName.includes("node_modules");
  });
}

function hasTypeFlag(type: ts.Type, flag: ts.TypeFlags): boolean {
  // biome-ignore lint/suspicious/noBitwiseOperators: ts.TypeFlags is a bitflag enum; masking is the API's membership test.
  return (type.flags & flag) !== 0;
}

/**
 * Strip the TS-internal symbol-ID counter from escaped well-known-symbol
 * member names (`__@toStringTag@715` → `__@toStringTag`); the counter is a
 * checker allocation order, not API surface.
 */
function normalizeMemberName(name: string): string {
  return name.replace(WELL_KNOWN_SYMBOL_ID_PATTERN, "$1");
}

/**
 * Read the `@experimental` TSDoc release tag wherever it is placed: on the
 * declaration itself, or on the enclosing statement (the barrel re-export
 * placement KRT-BJ006 landed — a `/** @experimental *​/` ahead of an
 * `export type { X } from ...` statement attaches to the ExportDeclaration,
 * while the symbol's declaration node is the inner ExportSpecifier).
 */
function symbolCarriesExperimentalTag(symbol: ts.Symbol): boolean {
  for (const declaration of symbol.getDeclarations() ?? []) {
    let node: ts.Node | undefined = declaration;

    while (node !== undefined && !ts.isSourceFile(node)) {
      if (
        ts.getJSDocTags(node).some((tag) => tag.tagName.text === "experimental")
      ) {
        return true;
      }

      node = node.parent;
    }
  }

  return false;
}

async function readSnapshot(): Promise<SnapshotFile | undefined> {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as SnapshotFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function writeSnapshot(
  live: ApiSurface,
  bump: string,
  changes: string[]
): Promise<void> {
  const previous = await readSnapshot();
  const snapshot: SnapshotFile = {
    $description:
      "ADR-054/056 frozen public API surface of @tuvren/core (root + subpaths) and @tuvren/sdk (root). Generated by tools/scripts/api-freeze-gate.ts; refresh with `bun run api-freeze` (allowed drift) or `bun run api-freeze --major` (declared breaking change). Do not edit by hand.",
    authority: ["ADR-054", "ADR-056", "ADR-057"],
    entrypoints: live,
    ledger: [
      ...(previous?.ledger ?? []),
      { bump, changes, recordedAt: new Date().toISOString() },
    ],
  };

  await mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);

  // Leave the checked-in artifact formatter-clean (repo generator rule): the
  // workspace formatter collapses short arrays differently than
  // JSON.stringify, so normalize through it rather than relying on a manual
  // format pass after regeneration.
  const format = spawnSync(
    "bunx",
    ["--bun", "@biomejs/biome", "format", "--write", SNAPSHOT_PATH],
    { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] }
  );

  if (format.status !== 0) {
    throw new Error(
      `[api-freeze-gate] formatter pass on the snapshot failed: ${format.stderr?.toString()}`
    );
  }
}

function printFindings(findings: DiffFinding[], label: string): void {
  for (const finding of findings) {
    const line = `[api-freeze-gate] ${label}: ${finding.entrypoint} export "${finding.exportName}" — ${finding.class}: ${finding.detail}`;

    if (finding.verdict === "blocked") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

function describeSurface(surface: ApiSurface): string {
  const entrypoints = Object.keys(surface);
  const exports = entrypoints.reduce(
    (total, entrypoint) =>
      total + Object.keys(surface[entrypoint] ?? {}).length,
    0
  );

  return `${entrypoints.length} entrypoints, ${exports} exports`;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  // Codepoint order, not localeCompare: the canonical snapshot order must not
  // depend on the regenerating machine's system locale.
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))
  );
}
