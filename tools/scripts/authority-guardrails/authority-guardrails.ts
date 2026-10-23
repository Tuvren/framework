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

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import nodePath from "node:path";

import { spawn } from "bun";

import { parseRegenerateCommandArgv } from "../lib/regenerate-command-argv.js";

const { relative, resolve } = nodePath;

interface AuthorityPacketManifest {
  authoritativeSources: {
    format: string;
    path: string;
  }[];
  conformancePlans?: {
    path: string;
    planId: string;
  }[];
  forbiddenAuthoritySources: string[];
  freshnessChecks?: {
    artifact: string;
    regenerateCommand: string;
  }[];
  generatedArtifacts?: {
    generatedFrom: string;
    path: string;
  }[];
  packetId: string;
}

export interface GuardrailFailure {
  check: string;
  message: string;
}

interface FileSnapshot {
  content: string;
  relativePath: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SPEC_ROOT = resolve(REPO_ROOT, "spec");
const TYPESCRIPT_ROOT = resolve(REPO_ROOT, "typescript");
const RUST_ROOT = resolve(REPO_ROOT, "rust");
const GO_ROOT = resolve(REPO_ROOT, "go");
const PYTHON_ROOT = resolve(REPO_ROOT, "python");
const DART_ROOT = resolve(REPO_ROOT, "dart");
const COMPATIBILITY_EVIDENCE_ROOT = resolve(
  REPO_ROOT,
  "reports/compatibility/evidence"
);
const FIXTURE_ROOT = resolve(
  REPO_ROOT,
  "tools/scripts/authority-guardrails/__fixtures__"
);
const ROOT_TESTS_ROOT = resolve(REPO_ROOT, "tests");
// The framework boundary's TypeScript implementation used to live entirely
// under one contract root (`boundaries/framework/implementations/typescript`)
// so a single subtree scan covered every framework-owned package. Since the
// M3 moves it is scattered across the language root (`typescript/runtime`,
// `typescript/testkit`, `typescript/conformance-adapter`, `typescript/streaming/*`,
// `typescript/telemetry/otel`, `typescript/runners/react`, …), so the
// equivalent live scan root is the whole `typescript/` tree — the patterns
// below are framework-fixture-specific enough that scanning kernel/providers
// packages too does not risk false positives.
// NOTE: the scan root is the ENTIRE typescript/ language tree, not one
// boundary subtree — patterns added to the lists below must stay
// framework-unique or they will false-positive on kernel/providers packages.
const TYPESCRIPT_SCAN_ROOT = "typescript";
const TYPESCRIPT_OWNED_CONFORMANCE_PATTERNS: readonly RegExp[] = [
  /@tuvren\/framework-testkit/u,
  /\bframeworkStreamTestFixtures\b/u,
  /(?:\.\.\/)+testkit/u,
];
const TYPESCRIPT_OWNED_FRAMEWORK_FIXTURE_PATTERNS: readonly RegExp[] = [
  /\bframeworkStreamTestFixtures\b/u,
  /\bFrameworkStreamTestFixtureSet\b/u,
  /framework-conformance-fixtures/u,
];
const ROOT_TUVREN_IMPORT_PATTERN = /@tuvren\//u;
const RUNNER_AGUI_EVENT_ENUM_PATTERN = /\bEventType\.[A-Z_]+\b/u;
const CALLABLES_NAMESPACE_PATTERN = /\bcallables\b/u;
const FORBIDDEN_RUNNER_OR_ADAPTER_TOKENS: readonly string[] = [
  "assertionResults",
  "checkId",
  "createCheckResult",
  "createConformanceEvidence",
  "emitEvidence",
  "failedChecks",
  "passedChecks",
  "requiredEvidence",
];
const FORBIDDEN_VOCABULARY_PATTERNS: readonly RegExp[] = [
  /\bPromise\b/u,
  /\bAsyncIterable\b/u,
  /\bAbortSignal\b/u,
  /\bUint8Array\b/u,
  /\bBuffer\b/u,
  /\bVec<u8>\b/u,
  /\breact_runner_[a-z0-9_]*\b/u,
  /\brust_framework_[a-z0-9_]*\b/u,
  /\btypescript_framework_[a-z0-9_]*\b/u,
];
const GENERIC_RUNNER_LITERAL_ALLOWLIST = new Set([
  "completed",
  "end_turn",
  "error",
  "fail",
  "failed",
  "paused",
]);

const forEachSequential = async <T>(
  values: Iterable<T>,
  operation: (value: T) => Promise<void>
): Promise<void> => {
  const iterator = values[Symbol.iterator]();
  const visitNext = async (): Promise<void> => {
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    await operation(next.value);
    await visitNext();
  };
  await visitNext();
};

const findFiles = async (
  directory: string,
  nameOrSuffix: string
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  await forEachSequential(entries, async (entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await findFiles(entryPath, nameOrSuffix)));
      return;
    }

    if (
      entry.isFile() &&
      (entry.name === nameOrSuffix || entry.name.endsWith(nameOrSuffix))
    ) {
      paths.push(entryPath);
    }
  });

  return paths;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAuthorityPacketManifest = (
  value: unknown
): value is AuthorityPacketManifest =>
  isRecord(value) &&
  typeof value.packetId === "string" &&
  Array.isArray(value.authoritativeSources) &&
  Array.isArray(value.forbiddenAuthoritySources);

const loadAuthorityPackets = async (): Promise<AuthorityPacketManifest[]> => {
  // No existsSync guard on the root: a missing spec/ (sparse checkout,
  // wrong cwd) must fail this gate loudly, never pass it vacuously.
  const manifestPaths = await findFiles(SPEC_ROOT, "authority-packet.json");
  if (manifestPaths.length === 0) {
    throw new Error(
      `authority guardrails found zero packets under ${SPEC_ROOT} — refusing to report a vacuous pass`
    );
  }
  const manifests: AuthorityPacketManifest[] = [];

  await forEachSequential(manifestPaths, async (manifestPath) => {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf-8"));

    if (isAuthorityPacketManifest(value)) {
      manifests.push(value);
    }
  });

  return manifests;
};

const checkFreshnessDeclarations = (
  manifests: readonly AuthorityPacketManifest[]
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    const freshnessChecks = new Map(
      (manifest.freshnessChecks ?? []).map((check) => [check.artifact, check])
    );

    for (const artifact of manifest.generatedArtifacts ?? []) {
      if (!existsSync(resolve(REPO_ROOT, artifact.path))) {
        failures.push({
          check: "freshness-check",
          message: `${manifest.packetId} generated artifact is missing: ${artifact.path}`,
        });
      }

      const check = freshnessChecks.get(artifact.path);

      if (check === undefined || check.regenerateCommand.trim().length === 0) {
        failures.push({
          check: "freshness-check",
          message: `${manifest.packetId} generated artifact lacks regenerate command: ${artifact.path}`,
        });
        continue;
      }

      try {
        parseRegenerateCommandArgv(check.regenerateCommand);
      } catch (error) {
        failures.push({
          check: "freshness-check",
          message:
            `${manifest.packetId} generated artifact has an invalid regenerate command for ` +
            `${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return failures;
};

const groupFreshnessChecksByCommand = (
  manifest: AuthorityPacketManifest
): Map<string, FreshnessCheckEntry[]> => {
  // One regenerate command may produce multiple artifacts. Group freshness
  // checks by command so we snapshot every relevant artifact before running
  // the command once, then compare each artifact's after-state. Running the
  // command separately per artifact would mask drift on every artifact past
  // the first because the command itself updates them all in lockstep.
  const checksByCommand = new Map<string, FreshnessCheckEntry[]>();

  for (const check of manifest.freshnessChecks ?? []) {
    const artifactPath = resolve(REPO_ROOT, check.artifact);

    if (!existsSync(artifactPath)) {
      continue;
    }

    const entry: FreshnessCheckEntry = {
      artifact: check.artifact,
      artifactPath,
    };
    const existing = checksByCommand.get(check.regenerateCommand);

    if (existing === undefined) {
      checksByCommand.set(check.regenerateCommand, [entry]);
    } else {
      existing.push(entry);
    }
  }

  return checksByCommand;
};

const collectSnapshotEntries = async (
  rootPath: string,
  currentPath: string
): Promise<FileSnapshot[]> => {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const snapshots: FileSnapshot[] = [];

  await forEachSequential(entries, async (entry) => {
    const entryPath = resolve(currentPath, entry.name);

    if (entry.isDirectory()) {
      snapshots.push(...(await collectSnapshotEntries(rootPath, entryPath)));
      return;
    }

    if (entry.isFile()) {
      snapshots.push({
        content: await readFile(entryPath, "utf-8"),
        relativePath: relative(rootPath, entryPath),
      });
    }
  });

  return snapshots;
};

const snapshotPath = async (path: string): Promise<FileSnapshot[]> => {
  const stats = await stat(path);

  if (stats.isFile()) {
    return [
      {
        content: await readFile(path, "utf-8"),
        relativePath: relative(path, path),
      },
    ];
  }

  const entries = await collectSnapshotEntries(path, path);
  return entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
};

const runRegenerateCommand = async (
  command: string
): Promise<{ message: string; ok: boolean }> => {
  // A manifest-owned regenerateCommand is untrusted input (any pull request
  // can edit a checked-in authority-packet.json), so it is parsed into an
  // argv array and rejected loud rather than handed to a shell. See
  // ../lib/regenerate-command-argv.ts for the metacharacter denylist and
  // command-prefix allowlist this enforces.
  let argv: string[];

  try {
    argv = parseRegenerateCommandArgv(command);
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }

  const [executable, ...args] = argv;

  if (executable === undefined) {
    return {
      message: `regenerateCommand "${command}" produced an empty argv`,
      ok: false,
    };
  }

  // Freshness checks intentionally execute the manifest-owned command instead
  // of duplicating generator knowledge in this guardrail.
  try {
    const subprocess = spawn([executable, ...args], {
      cwd: REPO_ROOT,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    // Concurrent readers retain stdout/stderr chunk arrival order.
    const outputChunks: string[] = [];
    const collectOutput = async (
      stream: ReadableStream<Uint8Array> | null | undefined
    ): Promise<void> => {
      if (stream === null || stream === undefined) {
        return;
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            outputChunks.push(decoder.decode());
            return;
          }
          outputChunks.push(decoder.decode(chunk.value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
    };
    const [exitCode] = await Promise.all([
      subprocess.exited,
      collectOutput(subprocess.stdout),
      collectOutput(subprocess.stderr),
    ]);
    return {
      message: outputChunks.join("").trim().slice(-1000),
      ok: exitCode === 0,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
};

const snapshotsAreEqual = (
  left: readonly FileSnapshot[],
  right: readonly FileSnapshot[]
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.relativePath === other.relativePath &&
      entry.content === other.content
    );
  });
};

const checkFreshnessForCommand = async (
  packetId: string,
  command: string,
  checks: readonly FreshnessCheckEntry[]
): Promise<GuardrailFailure[]> => {
  const failures: GuardrailFailure[] = [];
  const beforeSnapshots = new Map<string, FileSnapshot[]>();

  await forEachSequential(checks, async (check) => {
    beforeSnapshots.set(check.artifact, await snapshotPath(check.artifactPath));
  });

  const result = await runRegenerateCommand(command);

  if (!result.ok) {
    for (const check of checks) {
      failures.push({
        check: "freshness-check",
        message: `${packetId} regenerate command failed for ${check.artifact}: ${result.message}`,
      });
    }
    return failures;
  }

  await forEachSequential(checks, async (check) => {
    const after = await snapshotPath(check.artifactPath);
    const before = beforeSnapshots.get(check.artifact) ?? [];

    if (!snapshotsAreEqual(before, after)) {
      failures.push({
        check: "freshness-check",
        message: `${packetId} generated artifact drifted after ${command}: ${check.artifact}`,
      });
    }
  });

  return failures;
};

const checkFreshnessDrift = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> => {
  const failures: GuardrailFailure[] = [];

  await forEachSequential(manifests, async (manifest) => {
    const checksByCommand = groupFreshnessChecksByCommand(manifest);

    await forEachSequential(
      checksByCommand.entries(),
      async ([command, checks]) => {
        failures.push(
          ...(await checkFreshnessForCommand(
            manifest.packetId,
            command,
            checks
          ))
        );
      }
    );
  });

  return failures;
};

const collectForbiddenAuthorityEvidenceFailures = (
  evidenceText: string,
  evidenceLabel: string,
  manifests: readonly AuthorityPacketManifest[]
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  for (const manifest of manifests) {
    for (const forbiddenSource of manifest.forbiddenAuthoritySources) {
      if (forbiddenSource.length <= 4) {
        continue;
      }

      if (evidenceText.includes(forbiddenSource)) {
        failures.push({
          check: "forbidden-authority-source",
          message: `${evidenceLabel} cites forbidden authority source ${forbiddenSource} for ${manifest.packetId}`,
        });
      }
    }
  }

  return failures;
};

const checkForbiddenAuthorityEvidence = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> => {
  const evidencePaths = await findFiles(COMPATIBILITY_EVIDENCE_ROOT, ".json");
  const failures: GuardrailFailure[] = [];

  await forEachSequential(evidencePaths, async (evidencePath) => {
    const evidenceText = await readFile(evidencePath, "utf-8");
    failures.push(
      ...collectForbiddenAuthorityEvidenceFailures(
        evidenceText,
        relative(REPO_ROOT, evidencePath),
        manifests
      )
    );
  });

  return failures;
};

const findSourceFiles = async (directory: string): Promise<string[]> => {
  if (!existsSync(directory)) {
    return [];
  }

  const paths = [
    ...(await findFiles(directory, ".rs")),
    ...(await findFiles(directory, ".ts")),
    ...(await findFiles(directory, ".tsx")),
    ...(await findFiles(directory, ".go")),
    ...(await findFiles(directory, ".py")),
    ...(await findFiles(directory, ".dart")),
  ];
  return paths.filter((path) => !path.endsWith(".d.ts"));
};

const checkRootTypescriptFixtures = async (): Promise<GuardrailFailure[]> => {
  const sourcePaths = await findSourceFiles(ROOT_TESTS_ROOT);
  const failures: GuardrailFailure[] = [];

  await forEachSequential(sourcePaths, async (sourcePath) => {
    const source = await readFile(sourcePath, "utf-8");
    const sourceLabel = relative(REPO_ROOT, sourcePath);

    if (ROOT_TUVREN_IMPORT_PATTERN.test(source)) {
      failures.push({
        check: "root-typescript-fixture",
        message: `${sourceLabel} imports a Tuvren TypeScript package; root tests must not own reusable contract or conformance fixtures`,
      });
    }
  });

  return failures;
};

// Repository structure allows two certification-wrapper naming styles (see
// CLAUDE.md's Structure section): a bare `certification` directory nested
// under `<lang>/` or `<lang>/<area>/` (typescript/kernel/certification), a
// suffixed `certification*` variant for multiple backends nested the same
// way (typescript/kernel/certification-postgres), and a hyphen-prefixed flat
// variant used by Rust/Go/Python crates and modules that cannot nest an
// `<area>/` directory under a single package root (rust/kernel-certification,
// go/kernel-certification, python/kernel-certification). The suffix matches
// are deliberately permissive-toward-scanning: a false positive only adds a
// scan root (stricter, never looser), so an unrelated future directory that
// happens to end in `-certification` costs a harmless extra scan rather than
// an enforcement gap.
const isCertificationDirName = (name: string): boolean =>
  name === "certification" ||
  name.startsWith("certification-") ||
  name.endsWith("-certification");

// Same two naming styles apply to conformance-adapter hosts: a bare
// `conformance-adapter` directory nested under `<lang>/` or `<lang>/<area>/`
// (typescript/kernel/conformance-adapter), or a hyphen-prefixed flat variant
// (rust/kernel-conformance-adapter, go/kernel-conformance-adapter,
// python/kernel-conformance-adapter).
const isConformanceAdapterDirName = (name: string): boolean =>
  name === "conformance-adapter" || name.endsWith("-conformance-adapter");

// Resolves a certification/conformance-adapter package directory to its
// language-convention scan roots, or null when the directory matches no
// known package layout (letting the caller keep recursing).
const packageSourceRootsFor = (entryPath: string): string[] | null => {
  if (existsSync(resolve(entryPath, "src"))) {
    // TypeScript, Rust, and Python adapters/certification wrappers keep
    // their sources under a `src/` subdirectory.
    return [resolve(entryPath, "src")];
  }

  if (existsSync(resolve(entryPath, "go.mod"))) {
    // Go adapters/certification wrappers use a flat layout: *.go files
    // live directly at the module root, marked by go.mod, with no
    // `src/` subdirectory.
    return [entryPath];
  }

  if (existsSync(resolve(entryPath, "pubspec.yaml"))) {
    // Dart adapters/certification wrappers keep sources under lib/,
    // bin/, test/, example/, and tool/ (Dart's own package convention),
    // marked by pubspec.yaml. Scan those subdirectories explicitly
    // instead of the package root so the generated .dart_tool/ cache can
    // never leak generated sources into the guardrail scan.
    const sourceRoots = ["lib", "bin", "test", "example", "tool"]
      .map((sourceDir) => resolve(entryPath, sourceDir))
      .filter((sourcePath) => existsSync(sourcePath));

    if (sourceRoots.length === 0) {
      // A pubspec.yaml package with none of the conventional source
      // subdirectories is a broken/unexpected layout, not a signal to
      // silently exclude it from the forbidden-token scan: throw here
      // for the same reason findConformanceSourceRoots throws on a
      // missing language root above.
      throw new Error(
        `authority-guardrails conformance-source scan found a pubspec.yaml package at ${relative(REPO_ROOT, entryPath)} with none of lib/, bin/, test/, example/, or tool/ — a package with no recognized source directory is a broken layout, not a signal to silently narrow the scan`
      );
    }

    return sourceRoots;
  }

  return null;
};

const collectConformanceSourceRoots = async (
  directory: string
): Promise<string[]> => {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const roots: string[] = [];

  await forEachSequential(entries, async (entry) => {
    const entryPath = resolve(directory, entry.name);

    if (!entry.isDirectory()) {
      return;
    }

    if (
      isCertificationDirName(entry.name) ||
      isConformanceAdapterDirName(entry.name)
    ) {
      const packageRoots = packageSourceRootsFor(entryPath);

      if (packageRoots !== null) {
        roots.push(...packageRoots);
        return;
      }
    }

    roots.push(...(await collectConformanceSourceRoots(entryPath)));
  });

  return roots;
};

const findConformanceSourceRoots = async (): Promise<string[]> => {
  // Every language root always exists post-cutover; a missing one is a
  // broken checkout and must throw, not silently narrow the scan.
  const fixedLanguageRoots = [
    TYPESCRIPT_ROOT,
    RUST_ROOT,
    GO_ROOT,
    PYTHON_ROOT,
    DART_ROOT,
  ];

  for (const root of fixedLanguageRoots) {
    if (!existsSync(root)) {
      throw new Error(
        `authority-guardrails conformance-source scan expected language root ${relative(REPO_ROOT, root)} to exist — a missing root is a broken checkout, not a signal to silently narrow the scan`
      );
    }
  }

  const collectedRoots = await Promise.all(
    fixedLanguageRoots.map(
      async (root) => await collectConformanceSourceRoots(root)
    )
  );
  const roots = collectedRoots.flat();
  return roots
    .map((root) => relative(REPO_ROOT, root))
    .toSorted((left, right) => left.localeCompare(right));
};

const collectTypescriptOwnedConformanceFailures = (
  source: string,
  sourceLabel: string
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  for (const pattern of TYPESCRIPT_OWNED_CONFORMANCE_PATTERNS) {
    if (pattern.test(source)) {
      failures.push({
        check: "typescript-owned-conformance-source",
        message: `${sourceLabel} cites TypeScript-owned testkit fixtures; promoted runner source must load boundary conformance-plan fixtures`,
      });
    }
  }

  return failures;
};

const checkTypescriptOwnedConformanceSources = async (): Promise<
  GuardrailFailure[]
> => {
  const failures: GuardrailFailure[] = [];
  const conformanceSourceRoots = await findConformanceSourceRoots();

  await forEachSequential(conformanceSourceRoots, async (runnerRoot) => {
    const sourcePaths = await findSourceFiles(resolve(REPO_ROOT, runnerRoot));

    await forEachSequential(sourcePaths, async (sourcePath) => {
      const source = await readFile(sourcePath, "utf-8");
      failures.push(
        ...collectTypescriptOwnedConformanceFailures(
          source,
          relative(REPO_ROOT, sourcePath)
        )
      );
    });
  });

  return failures;
};

const collectTypescriptOwnedFrameworkFixtureFailures = (
  source: string,
  sourceLabel: string
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  for (const pattern of TYPESCRIPT_OWNED_FRAMEWORK_FIXTURE_PATTERNS) {
    if (pattern.test(source)) {
      failures.push({
        check: "typescript-owned-framework-fixture",
        message: `${sourceLabel} contains a TypeScript-owned framework conformance fixture facade; use boundary conformance-plan fixtures instead`,
      });
    }
  }

  return failures;
};

const checkTypescriptOwnedFrameworkFixtures = async (): Promise<
  GuardrailFailure[]
> => {
  const sourcePaths = await findSourceFiles(
    resolve(REPO_ROOT, TYPESCRIPT_SCAN_ROOT)
  );
  const failures: GuardrailFailure[] = [];

  await forEachSequential(sourcePaths, async (sourcePath) => {
    const source = await readFile(sourcePath, "utf-8");
    failures.push(
      ...collectTypescriptOwnedFrameworkFixtureFailures(
        source,
        relative(REPO_ROOT, sourcePath)
      )
    );
  });

  return failures;
};

const isBooleanOraclePath = (path: string): boolean =>
  path === "$.callables" ||
  path.startsWith("$.callables.") ||
  path.startsWith("callables.");

const collectEvidencePathOracleFailures = (
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] => {
  if (!Array.isArray(check.evidence)) {
    return [];
  }

  return check.evidence
    .filter(
      (evidencePath): evidencePath is string =>
        typeof evidencePath === "string" && isBooleanOraclePath(evidencePath)
    )
    .map((evidencePath) => ({
      check: "plan-oracle-shape",
      message: `${planLabel} check ${String(check.checkId)} declares boolean-oracle evidence path ${evidencePath}`,
    }));
};

const collectSingleAssertionOracleFailures = (
  assertion: Record<string, unknown>,
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] => {
  const assertionKind = assertion.kind;

  if (assertionKind !== "evidenceField" && assertionKind !== "stateField") {
    return [];
  }

  const failures: GuardrailFailure[] = [];
  const field =
    typeof assertion.field === "string" ? assertion.field : undefined;

  if (field !== undefined && isBooleanOraclePath(field)) {
    failures.push({
      check: "plan-oracle-shape",
      message: `${planLabel} check ${String(check.checkId)} asserts boolean-oracle field ${field}`,
    });
  }

  return failures;
};

const collectAssertionOracleFailures = (
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] => {
  if (!Array.isArray(check.assertions)) {
    return [];
  }

  return check.assertions.flatMap((assertion) =>
    isRecord(assertion)
      ? collectSingleAssertionOracleFailures(assertion, check, planLabel)
      : []
  );
};

const readAssertions = (assertions: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(assertions)) {
    return [];
  }

  return assertions.filter(isRecord);
};

const isDecisiveAssertion = (assertion: Record<string, unknown>): boolean => {
  if (assertion.kind === "faultActivated") {
    return (
      typeof assertion.path === "string" &&
      assertion.path.startsWith("$.capture.")
    );
  }
  const { kind } = assertion;

  if (kind === "resultField") {
    return true;
  }

  if (
    kind === "stateField" ||
    kind === "eventSequence" ||
    kind === "terminalEvent" ||
    kind === "ordering" ||
    kind === "noEvent" ||
    kind === "errorEnvelope" ||
    // `secretAbsence` reads a concrete implementation surface from `$.result`
    // and fails the check when any configured secret (or a derived variant)
    // leaks into it. A leak is a real conformance failure, so the assertion is
    // decisive — not evidence-only bookkeeping.
    kind === "secretAbsence"
  ) {
    return true;
  }

  if (
    ![
      "schemaValid",
      "digest",
      "canonicalCbor",
      "identity",
      "referenceWalk",
    ].includes(String(kind))
  ) {
    return false;
  }

  const path = typeof assertion.path === "string" ? assertion.path : "$.result";
  return (
    path === "$.result" ||
    path.startsWith("$.result.") ||
    path === "$.events" ||
    path.startsWith("$.events.") ||
    path === "$.state" ||
    path.startsWith("$.state.")
  );
};

const hasDecisiveAssertion = (assertions: Record<string, unknown>[]): boolean =>
  assertions.some(isDecisiveAssertion);

const collectDecisiveAssertionFailures = (
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] => {
  const assertions = readAssertions(check.assertions);

  if (assertions.length === 0) {
    return [];
  }

  if (hasDecisiveAssertion(assertions)) {
    return [];
  }

  return [
    {
      check: "plan-decisive-assertion",
      message: `${planLabel} promoted check ${String(check.checkId)} has no decisive assertion`,
    },
  ];
};

const isFixtureEventAssertion = (assertion: unknown): boolean => {
  if (!isRecord(assertion)) {
    return false;
  }

  return (
    assertion.kind === "eventSequence" ||
    assertion.kind === "terminalEvent" ||
    assertion.kind === "ordering" ||
    assertion.kind === "noEvent"
  );
};

const collectFixtureSelfCertificationFailures = (
  check: Record<string, unknown>,
  planLabel: string
): GuardrailFailure[] => {
  const operation =
    typeof check.operation === "string" ? check.operation : undefined;

  if (operation?.endsWith(".fixture-events") === true) {
    return [
      {
        check: "plan-self-certification",
        message: `${planLabel} check ${String(check.checkId)} replays authority fixture events as implementation conformance`,
      },
    ];
  }

  if (
    check.fixture !== undefined &&
    operation?.startsWith("event-stream.") === true
  ) {
    return [
      {
        check: "plan-self-certification",
        message: `${planLabel} check ${String(check.checkId)} uses fixture input for event-stream implementation conformance; event-stream checks must consume implementation-emitted events`,
      },
    ];
  }

  if (
    check.fixture !== undefined &&
    Array.isArray(check.assertions) &&
    check.assertions.length > 0 &&
    check.assertions.every(isFixtureEventAssertion)
  ) {
    return [
      {
        check: "plan-self-certification",
        message: `${planLabel} check ${String(check.checkId)} asserts only fixture event shape; fixture validation must not count as implementation conformance`,
      },
    ];
  }

  return [];
};

const readPlanSteps = (
  check: Record<string, unknown>
): Record<string, unknown>[] => {
  if (!Array.isArray(check.steps)) {
    return [];
  }

  return check.steps.filter(isRecord);
};

const collectStepDecisiveAssertionFailures = (
  step: Record<string, unknown>,
  planLabel: string,
  checkId: string
): GuardrailFailure[] => {
  const assertions = readAssertions(step.assertions);

  if (assertions.length === 0) {
    return [];
  }

  if (hasDecisiveAssertion(assertions)) {
    return [];
  }

  return [
    {
      check: "step-decisive-assertion",
      message: `${planLabel} promoted check ${checkId} step ${String(step.stepId)} has no decisive assertion`,
    },
  ];
};

export const collectPlanEvidenceOracleShapeFailures = (
  planValue: unknown,
  planLabel: string
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return failures;
  }

  for (const check of planValue.checks) {
    if (!isRecord(check)) {
      continue;
    }

    failures.push(
      ...collectEvidencePathOracleFailures(check, planLabel),
      ...collectAssertionOracleFailures(check, planLabel),
      ...collectDecisiveAssertionFailures(check, planLabel),
      ...collectFixtureSelfCertificationFailures(check, planLabel),
      ...readPlanSteps(check).flatMap((step) =>
        collectAssertionOracleFailures(
          {
            ...step,
            checkId: `${String(check.checkId)}.${String(step.stepId)}`,
          },
          planLabel
        )
      ),
      ...readPlanSteps(check).flatMap((step) =>
        collectStepDecisiveAssertionFailures(
          step,
          planLabel,
          String(check.checkId)
        )
      ),
      ...readPlanSteps(check).flatMap((step) =>
        collectFixtureSelfCertificationFailures(
          {
            ...check,
            ...step,
            checkId: `${String(check.checkId)}.${String(step.stepId)}`,
          },
          planLabel
        )
      )
    );
  }

  return failures;
};

const checkPlanEvidenceOracleShapes = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> => {
  const failures: GuardrailFailure[] = [];

  await forEachSequential(manifests, async (manifest) => {
    await forEachSequential(manifest.conformancePlans ?? [], async (plan) => {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf-8")
      );
      failures.push(
        ...collectPlanEvidenceOracleShapeFailures(planValue, plan.path)
      );
    });
  });

  return failures;
};

const collectCheckIdsFromPlanValue = (
  planValue: unknown,
  planCheckIds: Set<string>
): void => {
  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return;
  }

  for (const check of planValue.checks) {
    if (isRecord(check) && typeof check.checkId === "string") {
      planCheckIds.add(check.checkId);
    }
  }
};

const collectPlanCheckIds = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<Set<string>> => {
  const planCheckIds = new Set<string>();

  await forEachSequential(manifests, async (manifest) => {
    await forEachSequential(manifest.conformancePlans ?? [], async (plan) => {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf-8")
      );

      collectCheckIdsFromPlanValue(planValue, planCheckIds);
    });
  });

  return planCheckIds;
};

const collectOperationNamesFromPlanValue = (
  planValue: unknown,
  operationNames: Set<string>
): void => {
  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return;
  }

  for (const check of planValue.checks) {
    if (!isRecord(check)) {
      continue;
    }

    if (typeof check.operation === "string") {
      operationNames.add(check.operation);
    }

    for (const step of readPlanSteps(check)) {
      if (typeof step.operation === "string") {
        operationNames.add(step.operation);
      }
    }
  }
};

const collectPlanOperationNames = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<Set<string>> => {
  const operationNames = new Set<string>();

  await forEachSequential(manifests, async (manifest) => {
    await forEachSequential(manifest.conformancePlans ?? [], async (plan) => {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf-8")
      );

      collectOperationNamesFromPlanValue(planValue, operationNames);
    });
  });

  return operationNames;
};

const collectStringLiterals = (value: unknown, literals: Set<string>): void => {
  if (typeof value === "string") {
    if (value.length >= 3 && !GENERIC_RUNNER_LITERAL_ALLOWLIST.has(value)) {
      literals.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLiterals(item, literals);
    }
    return;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStringLiterals(item, literals);
    }
  }
};

const collectAssertionLiteralsFromAssertions = (
  assertions: unknown,
  literals: Set<string>
): void => {
  if (!Array.isArray(assertions)) {
    return;
  }

  for (const assertion of assertions) {
    if (!isRecord(assertion)) {
      continue;
    }

    collectStringLiterals(assertion.equals, literals);
    collectStringLiterals(assertion.contains, literals);
    collectStringLiterals(assertion.eventType, literals);
  }
};

const collectAssertionLiteralsFromPlanValue = (
  planValue: unknown,
  literals: Set<string>
): void => {
  if (!(isRecord(planValue) && Array.isArray(planValue.checks))) {
    return;
  }

  for (const check of planValue.checks) {
    if (!isRecord(check)) {
      continue;
    }

    collectAssertionLiteralsFromAssertions(check.assertions, literals);

    for (const step of readPlanSteps(check)) {
      collectAssertionLiteralsFromAssertions(step.assertions, literals);
    }
  }
};

const collectPlanAssertionLiterals = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<Set<string>> => {
  const literals = new Set<string>();

  await forEachSequential(manifests, async (manifest) => {
    await forEachSequential(manifest.conformancePlans ?? [], async (plan) => {
      const planValue: unknown = JSON.parse(
        await readFile(resolve(REPO_ROOT, plan.path), "utf-8")
      );

      collectAssertionLiteralsFromPlanValue(planValue, literals);
    });
  });

  return literals;
};

const collectForbiddenRunnerOrAdapterTokenFailures = (
  source: string,
  sourceLabel: string
): GuardrailFailure[] =>
  FORBIDDEN_RUNNER_OR_ADAPTER_TOKENS.filter((token) =>
    source.includes(token)
  ).map((token) => ({
    check: "runner-or-adapter-authority",
    message: `${sourceLabel} embeds ${token}; runner and adapter roots must not own check-scoped grading, required-evidence, or compatibility evidence semantics`,
  }));

const collectRunnerCheckIdFailures = (
  source: string,
  sourceLabel: string,
  planCheckIds: ReadonlySet<string>
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  for (const checkId of planCheckIds) {
    if (source.includes(checkId)) {
      failures.push({
        check: "runner-oracle",
        message: `${sourceLabel} embeds conformance-plan check id ${checkId}; runner source must load plan data instead`,
      });
    }
  }

  return failures;
};

const collectRunnerAssertionLiteralFailures = (
  source: string,
  sourceLabel: string,
  planAssertionLiterals: ReadonlySet<string>
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];

  for (const literal of planAssertionLiterals) {
    if (source.includes(JSON.stringify(literal))) {
      failures.push({
        check: "runner-oracle",
        message: `${sourceLabel} embeds conformance-plan assertion literal ${literal}; runner source must load semantic expectations from plans`,
      });
    }
  }

  return failures;
};

const isAllowedOperationRoutingLine = (
  line: string,
  quotedOperation: string,
  twoLinesBefore: string,
  previousLine: string,
  nextLine: string
): boolean =>
  line.includes(`case ${quotedOperation}:`) ||
  line.includes(`${quotedOperation} =>`) ||
  line.includes(`${quotedOperation}:`) ||
  line.includes(`readOperationScenario(input, ${quotedOperation})`) ||
  (line.includes(quotedOperation) &&
    (previousLine.includes("readOperationScenario(") ||
      twoLinesBefore.includes("readOperationScenario(")) &&
    nextLine.includes(")"));

const collectRunnerOperationLiteralFailures = (
  source: string,
  sourceLabel: string,
  planOperationNames: ReadonlySet<string>
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [];
  const lines = source.split("\n");

  for (const operationName of planOperationNames) {
    const quotedOperation = JSON.stringify(operationName);

    for (const [index, line] of lines.entries()) {
      if (
        line.includes(quotedOperation) &&
        !isAllowedOperationRoutingLine(
          line,
          quotedOperation,
          lines[index - 2] ?? "",
          lines[index - 1] ?? "",
          lines[index + 1] ?? ""
        )
      ) {
        failures.push({
          check: "runner-oracle",
          message: `${sourceLabel}:${index + 1} embeds promoted operation ${operationName} outside generic routing/scenario validation`,
        });
      }
    }
  }

  return failures;
};

const checkRunnerSourceText = (
  source: string,
  sourceLabel: string,
  planCheckIds: ReadonlySet<string>,
  planOperationNames: ReadonlySet<string>,
  planAssertionLiterals: ReadonlySet<string>
): GuardrailFailure[] => {
  const failures: GuardrailFailure[] = [
    ...collectForbiddenRunnerOrAdapterTokenFailures(source, sourceLabel),
    ...collectRunnerCheckIdFailures(source, sourceLabel, planCheckIds),
    ...(sourceLabel.includes("/certification/")
      ? collectRunnerAssertionLiteralFailures(
          source,
          sourceLabel,
          planAssertionLiterals
        )
      : []),
    ...collectRunnerOperationLiteralFailures(
      source,
      sourceLabel,
      planOperationNames
    ),
  ];

  if (CALLABLES_NAMESPACE_PATTERN.test(source)) {
    failures.push({
      check: "runner-oracle",
      message: `${sourceLabel} embeds callables boolean-evidence namespace; promoted plans must assert raw observations`,
    });
  }

  if (RUNNER_AGUI_EVENT_ENUM_PATTERN.test(source)) {
    failures.push({
      check: "runner-oracle",
      message: `${sourceLabel} embeds AG-UI semantic event enum constants; runner source must read expected event names from plans`,
    });
  }

  if (source.includes("AUTHORITY_ORACLE_FIXTURE")) {
    failures.push({
      check: "runner-oracle",
      message: `${sourceLabel} contains a runner-oracle fixture marker`,
    });
  }

  return failures;
};

const checkRunnerSourceFile = async (
  sourcePath: string,
  planCheckIds: ReadonlySet<string>,
  planOperationNames: ReadonlySet<string>,
  planAssertionLiterals: ReadonlySet<string>
): Promise<GuardrailFailure[]> => {
  const source = await readFile(sourcePath, "utf-8");
  return checkRunnerSourceText(
    source,
    relative(REPO_ROOT, sourcePath),
    planCheckIds,
    planOperationNames,
    planAssertionLiterals
  );
};

const checkRunnerOracleLiterals = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> => {
  const failures: GuardrailFailure[] = [];
  const planCheckIds = await collectPlanCheckIds(manifests);
  const planOperationNames = await collectPlanOperationNames(manifests);
  const planAssertionLiterals = await collectPlanAssertionLiterals(manifests);
  const conformanceSourceRoots = await findConformanceSourceRoots();

  await forEachSequential(conformanceSourceRoots, async (runnerRoot) => {
    const sourcePaths = await findSourceFiles(resolve(REPO_ROOT, runnerRoot));

    await forEachSequential(sourcePaths, async (sourcePath) => {
      failures.push(
        ...(await checkRunnerSourceFile(
          sourcePath,
          planCheckIds,
          planOperationNames,
          planAssertionLiterals
        ))
      );
    });
  });

  return failures;
};

const checkForbiddenVocabulary = async (
  manifests: readonly AuthorityPacketManifest[]
): Promise<GuardrailFailure[]> => {
  const failures: GuardrailFailure[] = [];

  await forEachSequential(manifests, async (manifest) => {
    await forEachSequential(manifest.authoritativeSources, async (source) => {
      if (
        source.format !== "typespec" &&
        source.format !== "conformance-plan"
      ) {
        return;
      }

      const sourcePath = resolve(REPO_ROOT, source.path);

      if (!existsSync(sourcePath)) {
        return;
      }

      const sourceText = await readFile(sourcePath, "utf-8");

      for (const pattern of FORBIDDEN_VOCABULARY_PATTERNS) {
        if (pattern.test(sourceText)) {
          failures.push({
            check: "forbidden-vocabulary",
            message: `${manifest.packetId} authority source ${source.path} contains implementation vocabulary ${pattern.source}`,
          });
        }
      }
    });
  });

  return failures;
};

const runFixtureSelfTests = async (): Promise<GuardrailFailure[]> => {
  const failures: GuardrailFailure[] = [];

  const freshnessFixture: unknown = JSON.parse(
    await readFile(
      resolve(FIXTURE_ROOT, "freshness-drift/authority-packet.json"),
      "utf-8"
    )
  );

  if (
    !isAuthorityPacketManifest(freshnessFixture) ||
    checkFreshnessDeclarations([freshnessFixture]).length === 0
  ) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "freshness-drift fixture did not trigger the freshness guardrail",
    });
  }

  const evidenceFixture = await readFile(
    resolve(FIXTURE_ROOT, "forbidden-authority-evidence/evidence.json"),
    "utf-8"
  );
  const evidenceFailures = collectForbiddenAuthorityEvidenceFailures(
    evidenceFixture,
    "fixture evidence",
    [
      {
        authoritativeSources: [],
        forbiddenAuthoritySources: ["typescript/certification"],
        packetId: "tuvren.fixture.forbidden-authority-evidence",
      },
    ]
  );

  if (evidenceFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "forbidden-authority-evidence fixture did not trigger the evidence guardrail",
    });
  }

  const runnerFixture = await readFile(
    resolve(FIXTURE_ROOT, "runner-oracle/source.ts"),
    "utf-8"
  );
  const runnerFailures = checkRunnerSourceText(
    runnerFixture,
    "fixture runner",
    new Set(),
    new Set(["runtime.fixture-operation"]),
    new Set(["turn.start"])
  );

  if (runnerFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message: "runner-oracle fixture did not trigger the runner guardrail",
    });
  }

  const booleanOraclePlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              equals: true,
              field: "$.callables.providerGenerate",
              kind: "evidenceField",
            },
          ],
          checkId: "fixture.boolean-oracle",
          evidence: ["callables.providerGenerate"],
        },
      ],
    },
    "fixture boolean-oracle plan"
  );

  if (booleanOraclePlanFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "boolean-oracle fixture did not trigger the plan-shape guardrail",
    });
  }

  const evidenceOnlyPlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              equals: "ready",
              field: "$.answer",
              kind: "evidenceField",
            },
          ],
          checkId: "fixture.evidence-only",
          evidence: ["answer"],
          operation: "runtime.assertion",
        },
      ],
    },
    "fixture evidence-only plan"
  );

  if (evidenceOnlyPlanFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "evidence-only fixture did not trigger the decisive-assertion guardrail",
    });
  }

  const schemaOverEvidencePlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              kind: "schemaValid",
              path: "$.evidence",
              schema: "$.evidence.schema",
            },
          ],
          checkId: "fixture.schema-valid-evidence",
          evidence: ["schema"],
          operation: "runtime.assertion",
        },
        {
          assertions: [
            {
              kind: "schemaValid",
              path: "$.state",
              schema: "$.evidence.schema",
            },
          ],
          checkId: "fixture.schema-valid-state",
          operation: "runtime.assertion",
        },
      ],
    },
    "fixture schemaValid classification plan"
  );

  if (
    !schemaOverEvidencePlanFailures.some((failure) =>
      failure.message.includes("fixture.schema-valid-evidence")
    )
  ) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "schema-valid over evidence fixture did not trigger the decisive-assertion guardrail",
    });
  }

  const stepEvidenceOnlyPlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              eventType: "turn.end",
              kind: "terminalEvent",
            },
          ],
          checkId: "fixture.step-evidence-only",
          operation: "runtime.assertion",
          steps: [
            {
              assertions: [
                {
                  equals: "ready",
                  field: "$.answer",
                  kind: "evidenceField",
                },
              ],
              operation: "runtime.assertion",
              stepId: "trace",
            },
          ],
        },
      ],
    },
    "fixture step-evidence-only plan"
  );

  if (
    !stepEvidenceOnlyPlanFailures.some((failure) =>
      failure.message.includes("fixture.step-evidence-only step trace")
    )
  ) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "step evidence-only fixture did not trigger the step decisive-assertion guardrail",
    });
  }

  const selfCertifyingPlanFailures = collectPlanEvidenceOracleShapeFailures(
    {
      checks: [
        {
          assertions: [
            {
              equals: ["turn.start", "turn.end"],
              kind: "eventSequence",
              path: "$.type",
            },
          ],
          checkId: "fixture.self-certifying",
          fixture: "stream-events",
          operation: "event-stream.fixture-events",
        },
        {
          assertions: [
            {
              equals: ["RUN_STARTED", "RUN_FINISHED"],
              field: "$.eventTypes",
              kind: "evidenceField",
            },
          ],
          checkId: "fixture.projection-self-certifying",
          fixture: "stream-events",
          operation: "event-stream.agui-projection",
        },
      ],
    },
    "fixture self-certifying plan"
  );

  if (selfCertifyingPlanFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "self-certifying fixture plan did not trigger the plan guardrail",
    });
  }

  const stepOperationNames = new Set<string>();
  collectOperationNamesFromPlanValue(
    {
      checks: [
        {
          assertions: [],
          checkId: "fixture.step-operation",
          operation: "runtime.top-level-operation",
          steps: [
            {
              operation: "runtime.step-operation",
              stepId: "step",
            },
          ],
        },
      ],
    },
    stepOperationNames
  );

  if (!stepOperationNames.has("runtime.step-operation")) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "step operation fixture did not collect trace-step operation names",
    });
  }

  const stepAssertionLiterals = new Set<string>();
  collectAssertionLiteralsFromPlanValue(
    {
      checks: [
        {
          assertions: [],
          checkId: "fixture.step-assertion",
          operation: "runtime.top-level-operation",
          steps: [
            {
              assertions: [
                {
                  equals: "step-owned-literal",
                  field: "$.value",
                  kind: "evidenceField",
                },
              ],
              operation: "runtime.step-operation",
              stepId: "step",
            },
          ],
        },
      ],
    },
    stepAssertionLiterals
  );

  if (!stepAssertionLiterals.has("step-owned-literal")) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "step assertion fixture did not collect trace-step assertion literals",
    });
  }

  const typescriptOwnedFixture = await readFile(
    resolve(FIXTURE_ROOT, "typescript-owned-conformance/source.ts"),
    "utf-8"
  );
  const typescriptOwnedFailures = collectTypescriptOwnedConformanceFailures(
    typescriptOwnedFixture,
    "fixture runner"
  );

  if (typescriptOwnedFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "typescript-owned-conformance fixture did not trigger the TypeScript ownership guardrail",
    });
  }

  const frameworkFixtureFailures =
    collectTypescriptOwnedFrameworkFixtureFailures(
      typescriptOwnedFixture,
      "fixture runner"
    );

  if (frameworkFixtureFailures.length === 0) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "typescript-owned-conformance fixture did not trigger the framework fixture guardrail",
    });
  }

  const vocabularyFixture = await readFile(
    resolve(FIXTURE_ROOT, "forbidden-vocabulary/main.tsp"),
    "utf-8"
  );

  if (
    !FORBIDDEN_VOCABULARY_PATTERNS.some((pattern) =>
      pattern.test(vocabularyFixture)
    )
  ) {
    failures.push({
      check: "guardrail-fixture",
      message:
        "forbidden-vocabulary fixture did not trigger the vocabulary guardrail",
    });
  }

  return failures;
};

const main = async (): Promise<void> => {
  const manifests = await loadAuthorityPackets();
  const failures = [
    ...checkFreshnessDeclarations(manifests),
    ...(await checkFreshnessDrift(manifests)),
    ...(await checkForbiddenAuthorityEvidence(manifests)),
    ...(await checkRootTypescriptFixtures()),
    ...(await checkTypescriptOwnedConformanceSources()),
    ...(await checkTypescriptOwnedFrameworkFixtures()),
    ...(await checkPlanEvidenceOracleShapes(manifests)),
    ...(await checkRunnerOracleLiterals(manifests)),
    ...(await checkForbiddenVocabulary(manifests)),
    ...(await runFixtureSelfTests()),
  ];

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${failure.check}: ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("authority guardrails passed");
};

if (import.meta.main) {
  await main();
}

interface FreshnessCheckEntry {
  artifact: string;
  artifactPath: string;
}
