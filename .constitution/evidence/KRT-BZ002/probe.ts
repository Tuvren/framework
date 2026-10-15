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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const BASE_COMMIT = "bbb4e932591a28578c930faf44ce08024607b77c";
const EXPECTED_BUN = "1.4.2";
const EXPECTED_BIOME = /2\.5\.14/u;
const EXPECTED_OXLINT = /1\.86\.0/u;
const OWNED_ROOTS = [
  "typescript/providers/provider-api",
  "typescript/providers/bridge-ai-sdk",
  "typescript/providers/testkit",
  "typescript/providers/certification",
  "typescript/runners/react",
] as const;
const PROJECTS = [
  "runner-react",
  "providers-typescript-certification",
  "providers-testkit",
  "providers-bridge-ai-sdk",
  "provider-api",
] as const;
const DIRECTIVE_PATTERN =
  /^\s*\/\/ (biome-ignore(?:-all|-start|-end)?)(?:\s+)([^:]+):\s*(.*)$/u;
const RULE_MAPPING = {
  "lint/performance/noBarrelFile": "oxc/no-barrel-file",
  "lint/suspicious/useAwait": "eslint(require-await)",
} as const;

interface Directive {
  identity: string;
  path: string;
  line: number;
  directive: string;
  rule: keyof typeof RULE_MAPPING;
  original_reason: string;
}

interface Report {
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  stdin_sha256: string | null;
}

const repoArgument = process.argv[2];
const outputArgument = process.argv[3];
assert(repoArgument && outputArgument, "usage: bun probe.ts REPOSITORY OUTPUT");
const repo = path.resolve(repoArgument);
const output = path.resolve(outputArgument);
const raw = path.join(output, "raw");
assert(!output.startsWith(`${repo}${path.sep}`), "evidence must remain outside repo");
mkdirSync(raw, { recursive: true });
writeFileSync(path.join(output, "probe.ts"), readFileSync(import.meta.path));

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const saveJson = (target: string, value: unknown): void => {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};
const saveRaw = (name: string, value: unknown): void => {
  saveJson(path.join(raw, name), value);
};
const run = (command: string[], input?: string): Report => {
  const executable = command[0];
  assert(executable, "command must be nonempty");
  const stdoutPath = path.join(output, ".capture.stdout");
  const stderrPath = path.join(output, ".capture.stderr");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, command.slice(1), {
      cwd: repo,
      encoding: "utf8",
      input,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", stdoutFd, stderrFd],
      env: { ...process.env, NO_COLOR: "1", NX_DAEMON: "false" },
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  unlinkSync(stdoutPath);
  unlinkSync(stderrPath);
  assert(!result.error && result.status !== null, `failed to execute ${command.join(" ")}`);
  return {
    command,
    exit_code: result.status,
    stdout,
    stderr,
    stdin_sha256: input === undefined ? null : sha256(input),
  };
};
const git = (...args: string[]): string => {
  const report = run(["git", ...args]);
  assert.equal(report.exit_code, 0, report.stderr);
  return report.stdout;
};
const diagnostics = (report: Report): Record<string, unknown>[] => {
  const parsed: unknown = JSON.parse(report.stdout);
  assert(object(parsed) && Array.isArray(parsed.diagnostics), "missing diagnostics array");
  assert(parsed.diagnostics.every(object), "malformed diagnostics");
  return parsed.diagnostics;
};
const collect = (revision?: string): Directive[] => {
  const listing = revision
    ? git("ls-tree", "-r", "--name-only", "-z", revision, "--", ...OWNED_ROOTS)
    : git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...OWNED_ROOTS);
  const entries: Directive[] = [];
  for (const filename of [...new Set(listing.split("\0").filter(Boolean))].sort()) {
    const source = revision
      ? git("show", `${revision}:${filename}`)
      : readFileSync(path.join(repo, filename), "utf8");
    const occurrences = new Map<string, number>();
    for (const [index, line] of source.split("\n").entries()) {
      if (!line.includes("biome-ignore")) {
        continue;
      }
      const match = DIRECTIVE_PATTERN.exec(line);
      assert(match, `unrecognized directive at ${filename}:${index + 1}`);
      const rule = match[2]?.trim();
      const reason = match[3]?.trim();
      assert(rule && reason && rule in RULE_MAPPING, `unexpected rule/reason at ${filename}:${index + 1}`);
      const typedRule = rule as keyof typeof RULE_MAPPING;
      const occurrence = (occurrences.get(rule) ?? 0) + 1;
      occurrences.set(rule, occurrence);
      entries.push({
        identity: `${filename}::${rule}::${occurrence}`,
        path: filename,
        line: index + 1,
        directive: line,
        rule: typedRule,
        original_reason: reason,
      });
    }
  }
  return entries;
};

const beforeStatus = git("status", "--porcelain=v1");
assert.equal(beforeStatus, "", "M7 requires a clean worktree");
const measurementCommit = git("rev-parse", "HEAD").trim();
assert.equal(measurementCommit, BASE_COMMIT, "measurement must run at locked commit");
const baseline = collect(BASE_COMMIT);
const live = collect();
assert.equal(baseline.length, 19, "baseline must contain nineteen directives");
assert.equal(live.length, 19, "live inventory must contain nineteen directives");
assert.deepEqual(live, baseline, "baseline/live directive inventory or reason drift");
saveRaw("inventory.json", { baseline_commit: BASE_COMMIT, measurement_commit: measurementCommit, baseline, live });

const versions = {
  bun: run(["bun", "--version"]),
  biome: run(["bunx", "--bun", "@biomejs/biome", "--version"]),
  oxlint: run(["bunx", "--bun", "oxlint", "--version"]),
};
assert.equal(versions.bun.stdout.trim(), EXPECTED_BUN);
assert.match(versions.biome.stdout, EXPECTED_BIOME);
assert.match(versions.oxlint.stdout, EXPECTED_OXLINT);
saveRaw("versions.json", versions);

const biomeConfigBytes = readFileSync(path.join(repo, "biome.jsonc"));
const oxlintConfigBytes = readFileSync(path.join(repo, "oxlint.config.ts"));
const sourceDigests = Object.fromEntries(
  [...new Set(live.map((entry) => entry.path))].sort().map((filename) => [
    filename,
    { sha256: sha256(readFileSync(path.join(repo, filename))), bytes: statSync(path.join(repo, filename)).size },
  ])
);
saveRaw("source-config-digests.json", {
  sources: sourceDigests,
  configs: {
    "biome.jsonc": { sha256: sha256(biomeConfigBytes), bytes: biomeConfigBytes.byteLength },
    "oxlint.config.ts": { sha256: sha256(oxlintConfigBytes), bytes: oxlintConfigBytes.byteLength },
  },
});

const registry = run(["bunx", "--bun", "oxlint", "--rules", "--format=json"]);
assert.equal(registry.exit_code, 0, registry.stderr);
const rules: unknown = JSON.parse(registry.stdout);
assert(Array.isArray(rules) && rules.every(object));
assert(rules.some((item) => item.scope === "oxc" && item.value === "no-barrel-file"));
assert(rules.some((item) => item.scope === "eslint" && item.value === "require-await"));
saveRaw("oxlint-rules.json", registry);
const effectiveConfig = run(["bunx", "--bun", "oxlint", "--print-config"]);
assert.equal(effectiveConfig.exit_code, 0, effectiveConfig.stderr);
const config: unknown = JSON.parse(effectiveConfig.stdout);
assert(object(config) && object(config.rules));
assert.equal(config.rules["oxc/no-barrel-file"], "deny");
assert.equal(config.rules["require-await"], "deny");
saveRaw("oxlint-effective-config.json", effectiveConfig);

const nativeReports = new Map<string, Record<string, unknown>[]>();
const nativeSummary: unknown[] = [];
const retainedDiagnosticDrift: unknown[] = [];
for (const root of OWNED_ROOTS) {
  const slug = root.replaceAll("/", "-");
  const selection = run(["bunx", "--bun", "oxlint", "--debug=files", root]);
  assert.equal(selection.exit_code, 0, selection.stderr);
  for (const entry of live.filter((item) => item.path.startsWith(`${root}/`))) {
    assert(selection.stdout.includes(entry.path), `Oxlint selection misses ${entry.path}`);
  }
  saveRaw(`oxlint-${slug}-selection.json`, selection);
  const retained = run([
    "bunx", "--bun", "@biomejs/biome", "check", root,
    "--reporter=json", "--max-diagnostics=none",
  ]);
  const retainedDiagnostics = diagnostics(retained);
  if (retained.exit_code !== 0 || retainedDiagnostics.length > 0) {
    retainedDiagnosticDrift.push({ root, exit_code: retained.exit_code, diagnostics: retainedDiagnostics });
  }
  saveRaw(`biome-${slug}-suppressed.json`, retained);
  for (const typeAware of [false, true]) {
    const flavor = typeAware ? "type-aware" : "syntactic";
    const report = run([
      "bunx", "--bun", "oxlint", ...(typeAware ? ["--type-aware"] : []),
      "--format=json", root,
    ]);
    const findings = diagnostics(report);
    assert.equal(report.exit_code, 1, `expected known native debt in ${root} ${flavor}`);
    assert(findings.length > 0);
    assert(findings.every((item) => typeof item.code === "string" && typeof item.filename === "string"));
    nativeReports.set(`${root}:${flavor}`, findings);
    saveRaw(`oxlint-${slug}-${flavor}.json`, report);
    const counts = new Map<string, number>();
    for (const item of findings) {
      counts.set(String(item.code), (counts.get(String(item.code)) ?? 0) + 1);
    }
    nativeSummary.push({ root, flavor, exit_code: report.exit_code, diagnostics: findings.length, by_rule: Object.fromEntries([...counts].sort()) });
  }
}
saveRaw("native-summary.json", nativeSummary);

const entries = live.map((current, index) => {
  const source = readFileSync(path.join(repo, current.path), "utf8");
  const lines = source.split("\n");
  assert.equal(lines[current.line - 1], current.directive);
  lines[current.line - 1] = "";
  const virtualInput = lines.join("\n");
  const stdinReport = run([
    "bunx", "--bun", "@biomejs/biome", "check",
    `--stdin-file-path=${current.path}`, "--reporter=json", "--max-diagnostics=none",
  ], virtualInput);
  assert.equal(stdinReport.exit_code, 1);
  const number = String(index + 1).padStart(2, "0");
  saveRaw(`biome-${number}-virtual-stdin-unsuppressed.json`, stdinReport);

  const scratchPath = path.join(output, "scratch", current.path);
  mkdirSync(path.dirname(scratchPath), { recursive: true });
  const scratchCommand = [
    "bunx", "--bun", "@biomejs/biome", "check",
    `--config-path=${path.join(repo, "biome.jsonc")}`,
    "--vcs-enabled=false", scratchPath, "--reporter=json", "--max-diagnostics=none",
  ];
  writeFileSync(scratchPath, source);
  const suppressedMirror = run(scratchCommand);
  assert.equal(suppressedMirror.exit_code, 0, suppressedMirror.stderr);
  assert.equal(diagnostics(suppressedMirror).length, 0);
  saveRaw(`biome-${number}-scratch-suppressed.json`, suppressedMirror);
  writeFileSync(scratchPath, virtualInput);
  assert.equal(sha256(readFileSync(scratchPath)), stdinReport.stdin_sha256);
  const unsuppressedMirror = run(scratchCommand);
  const mirrorDiagnostics = diagnostics(unsuppressedMirror);
  const matchingBiome = mirrorDiagnostics.filter((item) => item.category === current.rule);
  assert.equal(unsuppressedMirror.exit_code, 1);
  assert(matchingBiome.length > 0, `retained Biome diagnostic did not fire for ${current.identity}`);
  saveRaw(`biome-${number}-scratch-unsuppressed.json`, unsuppressedMirror);
  assert.equal(readFileSync(path.join(repo, current.path), "utf8"), source);
  unlinkSync(scratchPath);

  const root = OWNED_ROOTS.find((candidate) => current.path.startsWith(`${candidate}/`));
  assert(root);
  const syntactic = nativeReports.get(`${root}:syntactic`);
  const typeAware = nativeReports.get(`${root}:type-aware`);
  assert(syntactic && typeAware);
  const nativeCandidate = RULE_MAPPING[current.rule];
  const nativeEquivalent = typeAware.filter(
    (item) => item.filename === current.path && item.code === nativeCandidate
  );
  if (current.rule === "lint/suspicious/useAwait") {
    assert(nativeEquivalent.length > 0, `fresh native counterpart missing for ${current.identity}`);
  } else {
    assert.equal(nativeEquivalent.length, 0, `unexpected barrel counterpart for ${current.identity}`);
  }
  const sourceDigest = sourceDigests[current.path];
  assert(sourceDigest);
  const nativeSlug = root.replaceAll("/", "-");
  const hasCounterpart = nativeEquivalent.length > 0;
  return {
    identity: current.identity,
    path: current.path,
    directive: current.directive,
    rule: current.rule,
    original_reason: current.original_reason,
    baseline_line: current.line,
    live_line: current.line,
    equivalent_native_rule: hasCounterpart ? nativeCandidate : null,
    native_candidate_rule: nativeCandidate,
    retained_checker_disposition: "retain-original-needed-while-biome-owns-path",
    native_admission_disposition: hasCounterpart
      ? "planned-replace-original-at-atomic-native-admission-with-measured-counterpart"
      : "planned-remove-original-at-atomic-native-admission-no-native-counterpart",
    original_reason_preserved: true,
    currently_retained: true,
    early_deletion: null,
    source_digest: sourceDigest,
    config_digests: {
      "biome.jsonc": sha256(biomeConfigBytes),
      "oxlint.config.ts": sha256(oxlintConfigBytes),
    },
    retained_proof: {
      root_suppressed_report: `raw/biome-${nativeSlug}-suppressed.json`,
      virtual_stdin_report: `raw/biome-${number}-virtual-stdin-unsuppressed.json`,
      virtual_stdin_sha256: stdinReport.stdin_sha256,
      suppressed_mirror_report: `raw/biome-${number}-scratch-suppressed.json`,
      unsuppressed_mirror_report: `raw/biome-${number}-scratch-unsuppressed.json`,
      expected_category: current.rule,
      matching_diagnostics: matchingBiome.length,
      scratch_discovery_option: "--vcs-enabled=false changes scratch discovery only; repository lint policy remains exact",
      product_bytes_unchanged: true,
    },
    native_proof: {
      syntactic_report: `raw/oxlint-${nativeSlug}-syntactic.json`,
      type_aware_report: `raw/oxlint-${nativeSlug}-type-aware.json`,
      registry_report: "raw/oxlint-rules.json",
      effective_config_report: "raw/oxlint-effective-config.json",
      equivalent_firing_diagnostics: nativeEquivalent,
      actual_file_diagnostic_codes: [...new Set(typeAware.filter((item) => item.filename === current.path).map((item) => item.code))].sort(),
      rationale: hasCounterpart
        ? "The enabled shipped eslint(require-await) rule fires in the fresh full type-aware project-root diagnostic; the async contract reason remains valid, so KRT-BZ004 may translate the directive atomically at native admission."
        : "The enabled shipped oxc/no-barrel-file rule does not fire in fresh syntactic or type-aware project-root diagnostics; unrelated findings cannot justify a native counterpart.",
    },
    producing_commit: measurementCommit,
  };
});
rmSync(path.join(output, "scratch"), { recursive: true, force: true });

const changesetPath = ".changeset/toolchain-bz-provider-runner-lint.md";
const changeset = readFileSync(path.join(repo, changesetPath), "utf8");
for (const packageName of ["@tuvren/provider-api", "@tuvren/provider-bridge-ai-sdk", "@tuvren/runner-react"]) {
  assert(changeset.includes(`"${packageName}": patch`), `missing direct changeset entry ${packageName}`);
}
saveRaw("changeset-direct-proof.json", { base_commit: BASE_COMMIT, changeset_path: changesetPath, contents: changeset });

const verification: Record<string, Report> = {};
for (const project of PROJECTS) {
  for (const target of ["typecheck", "test"] as const) {
    const name = `${project}-${target}`;
    const report = run(["bun", "run", "nx", "run", `${project}:${target}`]);
    verification[name] = report;
    saveRaw(`verify-${name}.json`, report);
    assert.equal(report.exit_code, 0, `${name} failed: ${report.stderr}`);
  }
}
const workspaceTypecheck = run(["bun", "run", "typecheck"]);
verification["workspace-typecheck"] = workspaceTypecheck;
saveRaw("verify-workspace-typecheck.json", workspaceTypecheck);
assert.equal(workspaceTypecheck.exit_code, 0, workspaceTypecheck.stderr);
const fullLint = run(["bun", "run", "lint"]);
verification["workspace-lint"] = fullLint;
saveRaw("verify-workspace-lint.json", fullLint);

const ledger = {
  schema_version: 1,
  ticket: "KRT-BZ002",
  future_handoff: "KRT-BZ004/suppressions.json",
  base_commit: BASE_COMMIT,
  producing_commit: measurementCommit,
  measurement_commit: measurementCommit,
  owned_paths: OWNED_ROOTS,
  identity_convention: "repository-relative path::Biome rule::one-based occurrence within that path/rule; line is informational",
  drift: { added: [], removed: [], changed_reasons: [] },
  diagnostic_drift: retainedDiagnosticDrift,
  counts: {
    baseline: baseline.length,
    live: live.length,
    retained_needed: entries.length,
    native_counterpart: entries.filter((entry) => entry.equivalent_native_rule !== null).length,
    no_native_counterpart: entries.filter((entry) => entry.equivalent_native_rule === null).length,
    early_deletions: 0,
    biome_directives_added: 0,
  },
  entries,
};
assert.equal(ledger.counts.native_counterpart, 15);
assert.equal(ledger.counts.no_native_counterpart, 4);
saveJson(path.join(output, "suppressions.json"), ledger);

const rawFiles = readdirSync(raw).sort();
const index = {
  schema_version: 1,
  ticket: "KRT-BZ002",
  base_commit: BASE_COMMIT,
  producing_commit: measurementCommit,
  files: rawFiles.map((filename) => {
    const fullPath = path.join(raw, filename);
    const contents = readFileSync(fullPath);
    return { path: `raw/${filename}`, sha256: sha256(contents), bytes: contents.byteLength, role: filename.startsWith("verify-") ? "verification" : "measurement" };
  }),
};
saveJson(path.join(output, "raw-index.json"), index);
const assertions = {
  status: fullLint.exit_code === 0 && retainedDiagnosticDrift.length === 0 ? "pass" : "drift",
  base_commit: BASE_COMMIT,
  producing_commit: measurementCommit,
  exact_identity_set_and_reasons: true,
  baseline_identities: baseline.length,
  live_identities: live.length,
  ledger_identities: entries.length,
  retained_biome_exact_diagnostic_for_each: true,
  needed_directives_remain: true,
  original_reasons_preserved: true,
  native_counterparts_actually_firing: ledger.counts.native_counterpart,
  no_counterpart_dispositions: ledger.counts.no_native_counterpart,
  early_deletions: [],
  native_suppressions_added: [],
  biome_directives_added: [],
  full_lint_exit_code: fullLint.exit_code,
  retained_diagnostic_drift: retainedDiagnosticDrift,
  workspace_typecheck_exit_code: workspaceTypecheck.exit_code,
  scoped_commands: Object.fromEntries(Object.entries(verification).map(([name, report]) => [name, report.exit_code])),
  raw_index_files: index.files.length,
  worktree_unchanged: git("status", "--porcelain=v1") === beforeStatus,
};
assert.equal(assertions.worktree_unchanged, true);
assert.equal(git("rev-parse", "HEAD").trim(), measurementCommit);
saveJson(path.join(output, "assertions.json"), assertions);
process.stdout.write(`KRT-BZ002 ${assertions.status.toUpperCase()}: ${entries.length} identities; ${ledger.counts.native_counterpart} measured native counterparts; ${ledger.counts.no_native_counterpart} no-counterpart dispositions; ${retainedDiagnosticDrift.length} retained-root diagnostic drift group(s).\n`);
