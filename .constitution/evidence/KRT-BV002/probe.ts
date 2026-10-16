import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const output = process.argv[3];
assert(repo && output, "usage: bun probe.ts REPOSITORY OUTPUT");
const resolvedRepo = path.resolve(repo);
const resolvedOutput = path.resolve(output);
assert(
  resolvedOutput !== resolvedRepo &&
    !resolvedOutput.startsWith(`${resolvedRepo}${path.sep}`),
  "evidence output must be outside the repository"
);
mkdirSync(resolvedOutput, { recursive: true });

for (const stale of [
  "_inspect-config.json",
  "_inspect-oxlint.json",
  "_inspect-oxlint.stderr",
  "raw-reports-index.json",
]) {
  rmSync(path.join(resolvedOutput, stale), { force: true });
}

const ownedPaths = [
  "tools/scripts/api-freeze-gate.test.ts",
  "tools/scripts/generator-oxfmt.test.ts",
  "tools/scripts/generated-prerequisites.test.ts",
  "tools/scripts/json-check.test.ts",
  "tools/scripts/json-check.ts",
  "tools/scripts/json-source-check.ts",
  "tools/scripts/json-source-integrity.test.ts",
  "tools/scripts/oxc-project-discovery.test.ts",
  "tools/scripts/telemetry-codegen.test.ts",
  "tools/scripts/typecheck-source-aliases.test.ts",
  "tools/scripts/kernel-interop-governance.ts",
  "tools/scripts/compile-with-migrations.ts",
  "tools/scripts/docs-authority-freeze-gate.ts",
  "tools/scripts/changeset-check.test.ts",
  "tools/scripts/portability-check.ts",
  "tools/scripts/host-boundary-gate.ts",
  "tools/scripts/changeset-check.ts",
  "tools/scripts/compatibility-report.ts",
  "tools/scripts/codegen.ts",
  "tools/scripts/telemetry-codegen.ts",
  "tools/scripts/verify-kernel.ts",
  "tools/scripts/portability-gate.ts",
  "tools/scripts/validate-workspace-test-coverage.ts",
  "tools/scripts/repl-host-interop-smoke.ts",
  "tools/scripts/epic-af-conformance-gap-plan.ts",
  "tools/scripts/release-lane.ts",
  "tools/scripts/publish-registry.ts",
  "tools/scripts/check.ts",
  "tools/scripts/conformance.ts",
  "tools/scripts/verify.ts",
  "tools/scripts/typecheck-project.ts",
  "tools/scripts/release-check.ts",
  "tools/scripts/api-freeze-gate.ts",
  "tools/scripts/kraken-surface-gate.ts",
  "tools/scripts/authority-guardrails",
  "tools/scripts/authority-packet",
] as const;

interface CommandRecord {
  id: string;
  command: string[];
  cwd: string;
  exit_code: number;
  stdout_file: string;
  stderr_file: string;
}

interface Directive {
  identity: string;
  path: string;
  directive: string;
  rule: string;
  original_reason: string;
  line: number;
}

interface Diagnostic {
  category?: unknown;
  code?: unknown;
  filename?: unknown;
  labels?: unknown;
  message?: unknown;
  severity?: unknown;
}

const commandRecords: CommandRecord[] = [];
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const writeJson = (name: string, value: unknown): void => {
  writeFileSync(
    path.join(resolvedOutput, name),
    `${JSON.stringify(value, null, 2)}\n`
  );
};
const runInternal = (command: string[]): Buffer => {
  const executable = command[0];
  assert(executable, "command must not be empty");
  const result = spawnSync(executable, command.slice(1), {
    cwd: resolvedRepo,
    env: { ...process.env, NO_COLOR: "1", NX_SKIP_NX_CACHE: "true" },
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    0,
    Buffer.from(result.stderr ?? []).toString("utf8")
  );
  return Buffer.from(result.stdout ?? []);
};
const run = (
  id: string,
  command: string[],
  stdoutFile: string,
  stderrFile: string
): { exitCode: number; stdout: Buffer; stderr: Buffer } => {
  const executable = command[0];
  assert(executable, "command must not be empty");
  const stdoutPath = path.join(resolvedOutput, stdoutFile);
  const stderrPath = path.join(resolvedOutput, stderrFile);
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, command.slice(1), {
      cwd: resolvedRepo,
      env: { ...process.env, NO_COLOR: "1", NX_SKIP_NX_CACHE: "true" },
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, null);
  const stdout = readFileSync(stdoutPath);
  const stderr = readFileSync(stderrPath);
  commandRecords.push({
    id,
    command,
    cwd: resolvedRepo,
    exit_code: result.status ?? -1,
    stdout_file: stdoutFile,
    stderr_file: stderrFile,
  });
  return { exitCode: result.status ?? -1, stdout, stderr };
};
const parseJson = (value: Buffer): unknown =>
  JSON.parse(value.toString("utf8"));
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const getDiagnostics = (value: Buffer): Diagnostic[] => {
  const parsed = parseJson(value);
  assert(isObject(parsed) && Array.isArray(parsed.diagnostics));
  assert(parsed.diagnostics.every(isObject));
  return parsed.diagnostics;
};
const getLine = (diagnostic: Diagnostic): number | null => {
  if (!Array.isArray(diagnostic.labels)) {
    return null;
  }
  for (const label of diagnostic.labels) {
    if (
      isObject(label) &&
      isObject(label.span) &&
      typeof label.span.line === "number"
    ) {
      return label.span.line;
    }
  }
  return null;
};

const measurementCommit = "99457fbb4fd517f1f867ae9267920bed59d887d5";
const currentCommit = runInternal(["git", "rev-parse", "HEAD"])
  .toString("utf8")
  .trim();
runInternal([
  "git",
  "merge-base",
  "--is-ancestor",
  measurementCommit,
  currentCommit,
]);
const beforeStatus = runInternal(["git", "status", "--porcelain=v1"]);
assert.equal(beforeStatus.length, 0, "measurement worktree must begin clean");
writeFileSync(path.join(resolvedOutput, "worktree-before.txt"), beforeStatus);

const trackedOutput = runInternal([
  "git",
  "ls-files",
  "-z",
  "--",
  ...ownedPaths,
]);
const files = trackedOutput
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();
const directivePattern =
  /^\s*\/\/\s*(biome-ignore(?:-all|-start|-end)?)\s+([^:]+):\s*(.+)$/u;
const collect = (read: (filename: string) => string): Directive[] => {
  const directives: Directive[] = [];
  for (const filename of files) {
    const occurrences = new Map<string, number>();
    for (const [index, line] of read(filename).split("\n").entries()) {
      if (!line.includes("biome-ignore")) {
        continue;
      }
      const match = directivePattern.exec(line);
      assert(match, `unrecognized Biome directive: ${filename}:${index + 1}`);
      const rule = match[2]?.trim();
      const reason = match[3]?.trim();
      assert(
        rule && reason,
        `directive lacks rule/reason: ${filename}:${index + 1}`
      );
      const occurrence = (occurrences.get(rule) ?? 0) + 1;
      occurrences.set(rule, occurrence);
      directives.push({
        identity: `${filename}::${rule}::${occurrence}`,
        path: filename,
        directive: line,
        rule,
        original_reason: reason,
        line: index + 1,
      });
    }
  }
  return directives;
};
const current = collect((filename) =>
  readFileSync(path.join(resolvedRepo, filename), "utf8")
);
const baseline = collect((filename) =>
  runInternal(["git", "show", `${measurementCommit}:${filename}`]).toString(
    "utf8"
  )
);
assert.equal(baseline.length, 2);
const directiveSemantics = (directives: readonly Directive[]) =>
  directives.map(({ identity, path: directivePath, rule, original_reason }) => ({
    identity,
    path: directivePath,
    rule,
    original_reason,
  }));
assert.deepEqual(directiveSemantics(current), directiveSemantics(baseline));
assert(
  current.every(
    (item) =>
      item.path === "tools/scripts/api-freeze-gate.ts" &&
      item.rule === "lint/suspicious/noBitwiseOperators"
  )
);

const sourcePath = "tools/scripts/api-freeze-gate.ts";
const sourceAbsolute = path.join(resolvedRepo, sourcePath);
const sourceAtCheckout = readFileSync(sourceAbsolute);
const sourceAtHead = runInternal([
  "git",
  "show",
  `${measurementCommit}:${sourcePath}`,
]);
const sourceBefore = sourceAtHead;
const sourceText = sourceAtHead.toString("utf8");
const operationPattern =
  /^\s*return \((symbol|type)\.flags & flag\) !== 0;$/gmu;
const readOperations = (text: string) => [...text.matchAll(operationPattern)].map((match) => ({
  operand: match[1],
  text: match[0]?.trim(),
  line: text.slice(0, match.index).split("\n").length,
}));
const operations = readOperations(sourceText);
const checkoutOperations = readOperations(sourceAtCheckout.toString("utf8"));
assert.deepEqual(
  checkoutOperations.map(({ operand, text }) => ({ operand, text })),
  operations.map(({ operand, text }) => ({ operand, text }))
);
assert.deepEqual(operations, [
  {
    operand: "symbol",
    text: "return (symbol.flags & flag) !== 0;",
    line: 141,
  },
  { operand: "type", text: "return (type.flags & flag) !== 0;", line: 585 },
]);

const fixtureDirectory = path.join(resolvedOutput, "fixture");
mkdirSync(fixtureDirectory, { recursive: true });
const fixtureOriginalPath = path.join(
  fixtureDirectory,
  "api-freeze-gate.original.ts"
);
const fixtureMigratedPath = path.join(
  fixtureDirectory,
  "api-freeze-gate.migrated.ts"
);
writeFileSync(fixtureOriginalPath, sourceBefore);
let migratedSource = sourceText;
const candidateDirectives = new Map<string, string>();
for (const item of current) {
  const indentation = /^\s*/u.exec(item.directive)?.[0] ?? "";
  const candidate = `${indentation}// oxlint-disable-next-line no-bitwise -- ${item.original_reason}`;
  assert(migratedSource.includes(item.directive));
  migratedSource = migratedSource.replace(item.directive, candidate);
  candidateDirectives.set(item.identity, candidate);
}
writeFileSync(fixtureMigratedPath, migratedSource);
assert.deepEqual(readFileSync(fixtureOriginalPath), sourceBefore);
assert.equal(
  migratedSource,
  current.reduce(
    (value, item) =>
      value.replace(
        item.directive,
        candidateDirectives.get(item.identity) ?? ""
      ),
    sourceText
  )
);

const versions = [
  run(
    "bun-version",
    ["bun", "--version"],
    "bun-version.stdout.txt",
    "bun-version.stderr.txt"
  ),
  run(
    "biome-version",
    ["bunx", "--bun", "@biomejs/biome", "--version"],
    "biome-version.stdout.txt",
    "biome-version.stderr.txt"
  ),
  run(
    "oxlint-version",
    ["bunx", "--bun", "oxlint", "--version"],
    "oxlint-version.stdout.txt",
    "oxlint-version.stderr.txt"
  ),
];
assert.equal(versions[0]?.stdout.toString("utf8").trim(), "1.4.2");
assert.match(versions[1]?.stdout.toString("utf8") ?? "", /2\.5\.14/u);
assert.match(versions[2]?.stdout.toString("utf8") ?? "", /1\.86\.0/u);

const biomeOriginal = run(
  "biome-original-measurement-source",
  [
    "bunx",
    "--bun",
    "@biomejs/biome",
    "check",
    `--config-path=${path.join(resolvedRepo, "biome.jsonc")}`,
    "--vcs-enabled=false",
    fixtureOriginalPath,
    "--reporter=json",
    "--max-diagnostics=none",
  ],
  "biome-original.json",
  "biome-original.stderr.txt"
);
assert.equal(biomeOriginal.exitCode, 0);
assert.equal(getDiagnostics(biomeOriginal.stdout).length, 0);

const biomeFixtureOriginal = run(
  "biome-original-byte-mirror",
  [
    "bunx",
    "--bun",
    "@biomejs/biome",
    "check",
    `--config-path=${path.join(resolvedRepo, "biome.jsonc")}`,
    "--vcs-enabled=false",
    fixtureOriginalPath,
    "--reporter=json",
    "--max-diagnostics=none",
  ],
  "biome-fixture-original.json",
  "biome-fixture-original.stderr.txt"
);
assert.equal(biomeFixtureOriginal.exitCode, 0);
assert.equal(getDiagnostics(biomeFixtureOriginal.stdout).length, 0);

const biomeMigrated = run(
  "biome-oxlint-comments-fixture",
  [
    "bunx",
    "--bun",
    "@biomejs/biome",
    "check",
    `--config-path=${path.join(resolvedRepo, "biome.jsonc")}`,
    "--vcs-enabled=false",
    fixtureMigratedPath,
    "--reporter=json",
    "--max-diagnostics=none",
  ],
  "biome-fixture-migrated.json",
  "biome-fixture-migrated.stderr.txt"
);
const migratedBiomeDiagnostics = getDiagnostics(biomeMigrated.stdout);
const bitwiseBiomeDiagnostics = migratedBiomeDiagnostics.filter(
  (item) => item.category === "lint/suspicious/noBitwiseOperators"
);
assert.equal(biomeMigrated.exitCode, 1);
assert.equal(migratedBiomeDiagnostics.length, 2);
assert.equal(bitwiseBiomeDiagnostics.length, 2);

const registry = run(
  "oxlint-rules",
  ["bunx", "--bun", "oxlint", "--rules", "--format=json"],
  "oxlint-rules.json",
  "oxlint-rules.stderr.txt"
);
assert.equal(registry.exitCode, 0);
const registeredRules = parseJson(registry.stdout);
assert(Array.isArray(registeredRules));
const registeredRule = registeredRules.find(
  (item) =>
    isObject(item) && item.scope === "eslint" && item.value === "no-bitwise"
);
assert(isObject(registeredRule));

const effectiveConfig = run(
  "oxlint-effective-config",
  ["bunx", "--bun", "oxlint", "--print-config"],
  "oxlint-effective-config.json",
  "oxlint-effective-config.stderr.txt"
);
assert.equal(effectiveConfig.exitCode, 0);
const effective = parseJson(effectiveConfig.stdout);
assert(isObject(effective) && isObject(effective.rules));
assert.equal(effective.rules["no-bitwise"], "deny");

const nativeRuns = [
  {
    flavor: "syntactic",
    report: run(
      "oxlint-actual-syntactic",
      [
        "bunx",
        "--bun",
        "oxlint",
        "--config",
        path.join(resolvedRepo, "oxlint.config.ts"),
        "--no-ignore",
        "--format=json",
        fixtureOriginalPath,
      ],
      "oxlint-actual-syntactic.json",
      "oxlint-actual-syntactic.stderr.txt"
    ),
  },
  {
    flavor: "type-aware",
    report: run(
      "oxlint-actual-type-aware",
      [
        "bunx",
        "--bun",
        "oxlint",
        "--config",
        path.join(resolvedRepo, "oxlint.config.ts"),
        "--no-ignore",
        "--type-aware",
        "--format=json",
        fixtureOriginalPath,
      ],
      "oxlint-actual-type-aware.json",
      "oxlint-actual-type-aware.stderr.txt"
    ),
  },
] as const;
const nativeProof = nativeRuns.map(({ flavor, report }) => {
  assert.equal(report.exitCode, 1);
  const allDiagnostics = getDiagnostics(report.stdout);
  assert(
    allDiagnostics.every(
      (item) =>
        typeof item.code === "string" && typeof item.filename === "string"
    )
  );
  const matching = allDiagnostics.filter(
    (item) => item.code === "eslint(no-bitwise)"
  );
  assert.equal(matching.length, 2);
  assert.deepEqual(matching.map(getLine), [141, 585]);
  assert(matching.every((item) => item.severity === "error"));
  return {
    flavor,
    exit_code: report.exitCode,
    total_diagnostics: allDiagnostics.length,
    equivalent_rule_diagnostics: matching.map((item) => ({
      code: item.code,
      severity: item.severity,
      message: item.message,
      filename: item.filename,
      line: getLine(item),
    })),
  };
});

const candidateFixture = run(
  "oxlint-candidate-comments-fixture",
  [
    "bunx",
    "--bun",
    "oxlint",
    "--config",
    path.join(resolvedRepo, "oxlint.config.ts"),
    "--no-ignore",
    "--report-unused-disable-directives",
    "--format=json",
    fixtureMigratedPath,
  ],
  "oxlint-fixture-migrated.json",
  "oxlint-fixture-migrated.stderr.txt"
);
const candidateFixtureDiagnostics = getDiagnostics(candidateFixture.stdout);
assert.equal(
  candidateFixtureDiagnostics.filter(
    (item) => item.code === "eslint(no-bitwise)"
  ).length,
  0
);

const verification = [
  {
    id: "scoped-tests",
    result: run(
      "verification-scoped-tests",
      [
        "bun",
        "test",
        "--isolate",
        "tools/scripts/api-freeze-gate.test.ts",
        "tools/scripts/generator-oxfmt.test.ts",
        "tools/scripts/generated-prerequisites.test.ts",
        "tools/scripts/json-check.test.ts",
        "tools/scripts/json-source-integrity.test.ts",
        "tools/scripts/oxc-project-discovery.test.ts",
        "tools/scripts/telemetry-codegen.test.ts",
        "tools/scripts/typecheck-source-aliases.test.ts",
        "tools/scripts/changeset-check.test.ts",
      ],
      "verification-scoped-tests.stdout.txt",
      "verification-scoped-tests.stderr.txt"
    ),
  },
  {
    id: "format-check",
    result: run(
      "verification-format-check",
      ["bun", "run", "format:check"],
      "verification-format-check.stdout.txt",
      "verification-format-check.stderr.txt"
    ),
  },
  {
    id: "lint",
    result: run(
      "verification-lint",
      ["bun", "run", "lint"],
      "verification-lint.stdout.txt",
      "verification-lint.stderr.txt"
    ),
  },
  {
    id: "typecheck",
    result: run(
      "verification-typecheck",
      ["bun", "run", "typecheck"],
      "verification-typecheck.stdout.txt",
      "verification-typecheck.stderr.txt"
    ),
  },
] as const;
for (const item of verification) {
  assert.equal(
    item.result.exitCode,
    0,
    `${item.id} failed; inspect its raw stdout/stderr files`
  );
}
assert.equal(
  candidateFixtureDiagnostics.filter((item) =>
    String(item.code).toLowerCase().includes("unused-disable")
  ).length,
  0
);

const configDigests = {
  biome_config_sha256: sha256(
    readFileSync(path.join(resolvedRepo, "biome.jsonc"))
  ),
  oxlint_config_sha256: sha256(
    readFileSync(path.join(resolvedRepo, "oxlint.config.ts"))
  ),
  package_manifest_sha256: sha256(
    readFileSync(path.join(resolvedRepo, "package.json"))
  ),
  bun_lock_sha256: sha256(
    readFileSync(path.join(resolvedRepo, "bun.lock"))
  ),
};
const sourceAfter = readFileSync(sourceAbsolute);
assert.deepEqual(sourceAfter, sourceAtCheckout);
const afterStatus = runInternal(["git", "status", "--porcelain=v1"]);
assert.deepEqual(afterStatus, beforeStatus);
writeFileSync(path.join(resolvedOutput, "worktree-after.txt"), afterStatus);

const drift = {
  added: current.filter(
    (entry) => !baseline.some((item) => item.identity === entry.identity)
  ),
  removed: baseline.filter(
    (entry) => !current.some((item) => item.identity === entry.identity)
  ),
  changed_reasons: current.filter((entry) =>
    baseline.some(
      (item) =>
        item.identity === entry.identity &&
        item.original_reason !== entry.original_reason
    )
  ),
};
assert.deepEqual(drift, { added: [], removed: [], changed_reasons: [] });

const sourceProof = {
  measurement_commit: measurementCommit,
  path: sourcePath,
  source_sha256_before: sha256(sourceBefore),
  source_sha256_at_measurement_commit: sha256(sourceAtHead),
  source_sha256_at_checkout_before: sha256(sourceAtCheckout),
  source_sha256_at_checkout_after: sha256(sourceAfter),
  source_bytes: sourceBefore.length,
  measured_source_equals_measurement_commit: sourceBefore.equals(sourceAtHead),
  checkout_source_unchanged_during_measurement:
    sourceAtCheckout.equals(sourceAfter),
  fixture_original_sha256: sha256(readFileSync(fixtureOriginalPath)),
  fixture_original_byte_equivalent:
    readFileSync(fixtureOriginalPath).equals(sourceBefore),
  fixture_migrated_sha256: sha256(readFileSync(fixtureMigratedPath)),
  only_directive_syntax_replaced: true,
  flag_membership_operations: operations,
  flag_membership_operations_unchanged: true,
};
writeJson("inventory.json", {
  measurement_commit: measurementCommit,
  owned_paths: ownedPaths,
  tracked_files_scanned: files.length,
  baseline,
  current,
  drift,
});
writeJson("source-proof.json", sourceProof);
writeJson("native-diagnostic-summary.json", {
  exact_rule_code: "eslint(no-bitwise)",
  effective_config_key: "no-bitwise",
  effective_severity: "deny",
  emitted_severity: "error",
  explicit_options: null,
  documented_default_options: { allow: [], int32Hint: false },
  registered_rule: registeredRule,
  runs: nativeProof,
  candidate_fixture: {
    exit_code: candidateFixture.exitCode,
    total_unrelated_diagnostics: candidateFixtureDiagnostics.length,
    no_bitwise_diagnostics: 0,
    unused_disable_diagnostics: 0,
  },
});

const entries = baseline.map((original, index) => {
  const live = current.find((item) => item.identity === original.identity);
  assert(live);
  const nativeLines = nativeProof.map((proof) => ({
    flavor: proof.flavor,
    diagnostic: proof.equivalent_rule_diagnostics[index],
  }));
  const candidateDirective = candidateDirectives.get(original.identity);
  assert(candidateDirective);
  return {
    identity: original.identity,
    path: original.path,
    rule: original.rule,
    directive: original.directive,
    original_reason: original.original_reason,
    baseline_line: original.line,
    current_line: live.line,
    original_reason_preserved: true,
    currently_retained: true,
    equivalent_native_rule: "eslint/no-bitwise",
    native_candidate_rule: "eslint/no-bitwise",
    native_candidate_directive: candidateDirective,
    native_candidate_options: {
      effective_config_key: "no-bitwise",
      effective_severity: "deny",
      emitted_severity: "error",
      explicit_options: null,
      documented_default_options: { allow: [], int32Hint: false },
    },
    retained_checker_disposition:
      "retain-original-needed-while-biome-owns-tools-scripts",
    native_admission_disposition:
      "planned-replace-original-at-CB-whole-tools-admission-with-measured-oxlint-counterpart",
    early_deletion: null,
    source_digests: {
      baseline_sha256: sha256(sourceAtHead),
      current_before_sha256: sha256(sourceAtCheckout),
      current_after_sha256: sha256(sourceAfter),
    },
    config_digests: configDigests,
    retained_proof: {
      actual_source_report: "biome-original.json",
      actual_source_exit_code: biomeOriginal.exitCode,
      original_fixture_report: "biome-fixture-original.json",
      original_fixture_exit_code: biomeFixtureOriginal.exitCode,
      migrated_fixture_report: "biome-fixture-migrated.json",
      migrated_fixture_exit_code: biomeMigrated.exitCode,
      expected_category: "lint/suspicious/noBitwiseOperators",
      matching_diagnostics_total: bitwiseBiomeDiagnostics.length,
      matching_diagnostic_ordinal: index + 1,
      migrated_fixture_sha256: sha256(readFileSync(fixtureMigratedPath)),
    },
    native_proof: {
      syntactic_report: "oxlint-actual-syntactic.json",
      type_aware_report: "oxlint-actual-type-aware.json",
      candidate_fixture_report: "oxlint-fixture-migrated.json",
      registry_report: "oxlint-rules.json",
      effective_config_report: "oxlint-effective-config.json",
      equivalent_firing_diagnostics: nativeLines,
      candidate_comment_suppresses_same_operation: true,
    },
    operation_proof: checkoutOperations[index],
    producing_commit: measurementCommit,
  };
});
const ledger = {
  schema_version: 1,
  ticket: "KRT-BV002",
  milestone: "M3",
  baseline_commit: measurementCommit,
  measurement_commit: measurementCommit,
  owned_paths: ownedPaths,
  identity_convention:
    "repository-relative path::Biome rule::one-based occurrence within that path/rule; line is informational",
  drift,
  entries,
};
writeJson("suppressions.json", ledger);
writeJson("commands.json", commandRecords);
writeJson("assertions.json", {
  status: "pass",
  measurement_commit: measurementCommit,
  baseline_directives: baseline.length,
  current_directives: current.length,
  ledger_entries: entries.length,
  full_identity_set_equality: true,
  original_reasons_preserved: true,
  no_added_biome_directives: true,
  needed_original_directives_retained: true,
  original_retained_biome_exit_code: biomeOriginal.exitCode,
  byte_equivalent_original_fixture_exit_code: biomeFixtureOriginal.exitCode,
  comments_only_migrated_fixture_exit_code: biomeMigrated.exitCode,
  comments_only_migrated_fixture_diagnostics: migratedBiomeDiagnostics.length,
  comments_only_migrated_fixture_noBitwiseOperators_diagnostics:
    bitwiseBiomeDiagnostics.length,
  oxlint_syntactic_equivalent_diagnostics:
    nativeProof[0].equivalent_rule_diagnostics.length,
  oxlint_type_aware_equivalent_diagnostics:
    nativeProof[1].equivalent_rule_diagnostics.length,
  exact_native_rule_code: "eslint(no-bitwise)",
  effective_native_severity: "deny",
  effective_native_explicit_options: null,
  native_candidate_comments_proven_used: true,
  current_source_unchanged_during_measurement: true,
  flag_membership_operations_unchanged: true,
  worktree_unchanged: true,
  early_deletions: [],
  native_suppressions_added_to_repository: [],
  verification_exit_codes: Object.fromEntries(
    verification.map((item) => [item.id, item.result.exitCode])
  ),
});
writeJson("summary.json", {
  ticket: "KRT-BV002",
  milestone: "M3",
  status: "pass",
  measurement_commit: measurementCommit,
  directives: 2,
  retained_biome: {
    original_exit: 0,
    migrated_comments_only_exit: 1,
    diagnostics: 2,
  },
  native_counterpart: {
    rule_code: "eslint(no-bitwise)",
    config_key: "no-bitwise",
    severity: "deny",
    explicit_options: null,
    syntactic_fires: 2,
    type_aware_fires: 2,
  },
  source_sha256: sha256(sourceAtHead),
  configs: configDigests,
  drift,
  verification_exit_codes: Object.fromEntries(
    verification.map((item) => [item.id, item.result.exitCode])
  ),
});

const listFiles = (directory: string, prefix = ""): string[] => {
  const result: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.join(prefix, name);
    if (statSync(absolute).isDirectory()) {
      result.push(...listFiles(absolute, relative));
    } else {
      result.push(relative);
    }
  }
  return result;
};
const indexedFiles = listFiles(resolvedOutput).filter(
  (name) => name !== "raw-reports-index.json"
);
writeJson("raw-reports-index.json", {
  schema_version: 1,
  root: resolvedOutput,
  self_exclusion:
    "raw-reports-index.json cannot contain a digest of its own final bytes; every other output present when the index was written is included",
  files: indexedFiles.map((name) => {
    const bytes = readFileSync(path.join(resolvedOutput, name));
    return { path: name, sha256: sha256(bytes), bytes: bytes.length };
  }),
});

process.stdout.write(
  `KRT-BV002 M3 PASS: ${entries.length} directives retained; Biome 0 -> 1/2 diagnostics; Oxlint eslint(no-bitwise) fires twice in syntactic and type-aware runs.\n`
);
