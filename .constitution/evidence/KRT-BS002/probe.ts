import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Read-only evidence probe, following KRT-BQ002. Run with the loaded repo environment.
const ownedPaths = [
  "typescript/kernel/grpc-client",
  "typescript/kernel/testkit",
  "typescript/kernel/certification",
  "typescript/kernel/certification-sqlite",
  "typescript/kernel/certification-postgres",
];
const codeRoots = ownedPaths.slice(0, 3);
const expectedRule = "lint/performance/noBarrelFile";
const directivePattern =
  /^\s*\/\/ (biome-ignore(?:-all|-start|-end)?)\s+([^:]+):\s*(.*)$/u;
const unixPattern = /^(.+?):(\d+):(\d+): (.*) \[(Error|Warning)\/(.+)\]$/u;
interface Directive {
  identity: string;
  path: string;
  line: number;
  directive: string;
  rule: string;
  original_reason: string;
}
interface Report {
  command: string[];
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_sha256: string;
  stderr_sha256: string;
}
interface Finding {
  path: string;
  line: number;
  column: number;
  message: string;
  severity: string;
  code: string;
}
const repoArgument = process.argv[2];
const outputArgument = process.argv[3];
const baselineCommit = process.argv[4];
assert(
  repoArgument && outputArgument && baselineCommit,
  "usage: bun probe.ts REPOSITORY EXTERNAL_OUTPUT BASELINE_COMMIT [LEDGER_TO_CHECK]"
);
assert.match(baselineCommit, /^[0-9a-f]{40}$/u);
const repo = path.resolve(repoArgument);
const output = path.resolve(outputArgument);
assert(
  output !== repo && !output.startsWith(`${repo}${path.sep}`),
  "outputs must be external"
);
assert.equal(
  process.cwd(),
  repo,
  "launch from assigned worktree; do not rely on bun --cwd"
);
mkdirSync(output, { recursive: true });
const digest = (contents: string | Buffer): string =>
  createHash("sha256").update(contents).digest("hex");
const save = (name: string, value: unknown): void => {
  writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
};
const run = (command: string[]): Report => {
  const executable = command[0];
  assert(executable);
  const stdoutPath = path.join(output, ".capture.stdout");
  const stderrPath = path.join(output, ".capture.stderr");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(executable, command.slice(1), {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: { ...process.env, NO_COLOR: "1" },
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  unlinkSync(stdoutPath);
  unlinkSync(stderrPath);
  assert(
    !result.error && result.status !== null,
    `execution failed: ${command.join(" ")}`
  );
  return {
    command,
    cwd: repo,
    exit_code: result.status,
    stdout,
    stderr,
    stdout_sha256: digest(stdout),
    stderr_sha256: digest(stderr),
  };
};
const capture = (name: string, command: string[]): Report => {
  const report = run(command);
  save(name, report);
  return report;
};
const git = (...args: string[]): string => {
  const report = run(["git", ...args]);
  assert.equal(report.exit_code, 0, report.stderr);
  return report.stdout;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const biomeDiagnostics = (report: Report): Record<string, unknown>[] => {
  const value: unknown = JSON.parse(report.stdout);
  assert(
    object(value) &&
      Array.isArray(value.diagnostics) &&
      value.diagnostics.every(object)
  );
  return value.diagnostics;
};
const nativeDiagnostics = (report: Report): Finding[] => {
  const findings: Finding[] = [];
  for (const line of report.stdout.split("\n")) {
    const match = unixPattern.exec(line);
    if (!match) {
      assert(
        !line.includes("[Error/") && !line.includes("[Warning/"),
        `unparsed diagnostic: ${line}`
      );
      continue;
    }
    const [, filename, lineNumber, column, message, severity, code] = match;
    assert(filename && lineNumber && column && message && severity && code);
    findings.push({
      path: filename,
      line: Number(lineNumber),
      column: Number(column),
      message,
      severity,
      code,
    });
  }
  const summary = /(?:^|\n)(\d+) problems?(?:\n|$)/u.exec(report.stdout);
  assert(summary?.[1], "unix report must include full diagnostic summary");
  assert.equal(
    findings.length,
    Number(summary[1]),
    "all unix diagnostics must be captured"
  );
  assert.equal(report.exit_code, 1, "known native debt remains nonzero");
  assert(findings.length > 0);
  assert(
    !/failed to (?:load|resolve)|could not (?:load|resolve)|project resolution error/iu.test(
      report.stderr
    ),
    "backend/config failure is not a rule diagnostic"
  );
  return findings;
};
const files = (revision?: string): string[] =>
  [
    ...new Set(
      (revision === undefined
        ? git(
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ...ownedPaths
          )
        : git(
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            revision,
            "--",
            ...ownedPaths
          )
      )
        .split("\0")
        .filter(Boolean)
    ),
  ].sort();
const collect = (revision?: string): Directive[] => {
  const entries: Directive[] = [];
  for (const filename of files(revision)) {
    const source =
      revision === undefined
        ? readFileSync(path.join(repo, filename), "utf8")
        : git("show", `${revision}:${filename}`);
    const occurrences = new Map<string, number>();
    for (const [index, line] of source.split("\n").entries()) {
      if (!line.includes("biome-ignore")) continue;
      const match = directivePattern.exec(line);
      assert(match, `unrecognized directive ${filename}:${index + 1}`);
      const rule = match[2]?.trim();
      const reason = match[3];
      assert(rule && reason, "directive requires rule and original reason");
      const occurrence = (occurrences.get(rule) ?? 0) + 1;
      occurrences.set(rule, occurrence);
      entries.push({
        identity: `${filename}::${rule}::${occurrence}`,
        path: filename,
        line: index + 1,
        directive: line,
        rule,
        original_reason: reason,
      });
    }
  }
  return entries;
};
const productHashes = (): Record<string, string> =>
  Object.fromEntries(
    files().map((filename) => [
      filename,
      digest(readFileSync(path.join(repo, filename))),
    ])
  );
const beforeStatus = git("status", "--porcelain=v1");
assert(
  beforeStatus
    .split("\n")
    .filter(Boolean)
    .every((line) => line.slice(3).startsWith(".constitution/")),
  "only lead bookkeeping may preexist"
);
const measurementCommit = git("rev-parse", "HEAD").trim();
const beforeHashes = productHashes();
const baseline = collect(baselineCommit);
const live = collect();
save("inventory.json", {
  baseline_commit: baselineCommit,
  measurement_commit: measurementCommit,
  baseline,
  live,
  preexisting_status: beforeStatus,
  product_sha256: beforeHashes,
});
const versions = [
  run(["bun", "--version"]),
  run(["bunx", "--bun", "@biomejs/biome", "--version"]),
  run(["bunx", "--bun", "oxlint", "--version"]),
];
save("versions.json", versions);
assert.equal(versions[0]?.stdout.trim(), "1.4.2");
assert.match(versions[1]?.stdout ?? "", /2\.5\.14/u);
assert.match(versions[2]?.stdout ?? "", /1\.86\.0/u);
const registry = capture("oxlint-rules.json", [
  "bunx",
  "--bun",
  "oxlint",
  "--rules",
  "--format=json",
]);
const registryValue: unknown = JSON.parse(registry.stdout);
assert.equal(registry.exit_code, 0);
assert(Array.isArray(registryValue) && registryValue.every(object));
assert(
  registryValue.some(
    (item) => item.scope === "oxc" && item.value === "no-barrel-file"
  )
);
const effective = capture("oxlint-effective-config.json", [
  "bunx",
  "--bun",
  "oxlint",
  "--print-config",
]);
const config: unknown = JSON.parse(effective.stdout);
assert.equal(effective.exit_code, 0);
assert(object(config) && object(config.rules));
assert.equal(config.rules["oxc/no-barrel-file"], "deny");
const retained = capture("biome-retained.json", [
  "bunx",
  "--bun",
  "@biomejs/biome",
  "lint",
  ...codeRoots,
]);
assert.equal(retained.exit_code, 0, retained.stderr);
const combined = capture("oxlint-combined-type-aware.json", [
  "bunx",
  "--bun",
  "oxlint",
  "--type-aware",
  "--format=unix",
  ...codeRoots,
]);
const combinedFindings = nativeDiagnostics(combined);
const nativeReports = new Map<string, Finding[]>();
const nativeSummary: unknown[] = [];
for (const root of codeRoots) {
  const area = path.basename(root);
  const selection = capture(`oxlint-${area}-selection.json`, [
    "bunx",
    "--bun",
    "oxlint",
    "--debug=files",
    root,
  ]);
  assert.equal(selection.exit_code, 0);
  for (const entry of live.filter((item) => item.path.startsWith(`${root}/`)))
    assert(selection.stdout.includes(entry.path));
  for (const typeAware of [false, true]) {
    const flavor = typeAware ? "type-aware" : "syntactic";
    const report = capture(`oxlint-${area}-${flavor}.json`, [
      "bunx",
      "--bun",
      "oxlint",
      ...(typeAware ? ["--type-aware"] : []),
      "--format=unix",
      root,
    ]);
    const findings = nativeDiagnostics(report);
    const counts = new Map<string, number>();
    for (const finding of findings)
      counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
    nativeReports.set(`${root}:${flavor}`, findings);
    nativeSummary.push({
      root,
      flavor,
      exit_code: report.exit_code,
      diagnostics: findings.length,
      by_rule: Object.fromEntries([...counts].sort()),
    });
  }
}
const separateFindings = codeRoots.flatMap(
  (root) => nativeReports.get(`${root}:type-aware`) ?? []
);
assert.deepEqual(
  combinedFindings.map((item) => JSON.stringify(item)).sort(),
  separateFindings.map((item) => JSON.stringify(item)).sort(),
  "combined native report must exactly match per-root reports"
);
save("native-summary.json", {
  combined_diagnostics: combinedFindings.length,
  per_root: nativeSummary,
});
const retainedRoots: unknown = JSON.parse(
  readFileSync(path.join(repo, "tools/biome-coverage/bs.json"), "utf8")
);
assert(Array.isArray(retainedRoots));
for (const root of ownedPaths)
  assert(retainedRoots.includes(root), `Biome ownership must remain: ${root}`);
const drift = {
  added: live.filter(
    (entry) => !baseline.some((item) => item.identity === entry.identity)
  ),
  removed: baseline.filter(
    (entry) => !live.some((item) => item.identity === entry.identity)
  ),
  changed_reasons: live.filter((entry) =>
    baseline.some(
      (item) =>
        item.identity === entry.identity &&
        item.original_reason !== entry.original_reason
    )
  ),
};
assert.deepEqual(
  drift,
  { added: [], removed: [], changed_reasons: [] },
  "new drift requires measured review; never silently omit it"
);
const entries = baseline.map((original, index) => {
  const current = live.find((entry) => entry.identity === original.identity);
  assert(current);
  assert.equal(
    current.directive,
    original.directive,
    "original directive bytes remain"
  );
  assert.equal(
    current.rule,
    expectedRule,
    "other rules require new equivalence review"
  );
  const source = readFileSync(path.join(repo, current.path), "utf8");
  const lines = source.split("\n");
  assert.equal(lines[current.line - 1], original.directive);
  lines[current.line - 1] = ""; // Preserve line numbers; only the external mirror changes.
  const virtualInput = lines.join("\n");
  const scratchPath = path.join(output, "scratch", current.path);
  mkdirSync(path.dirname(scratchPath), { recursive: true });
  const command = [
    "bunx",
    "--bun",
    "@biomejs/biome",
    "lint",
    `--config-path=${path.join(repo, "biome.jsonc")}`,
    "--vcs-enabled=false",
    scratchPath,
    "--reporter=json",
    "--max-diagnostics=none",
  ];
  writeFileSync(scratchPath, source);
  const suppressedName = `biome-suppressed-mirror-${index + 1}.json`;
  const suppressed = capture(suppressedName, command);
  assert.equal(suppressed.exit_code, 0, suppressed.stderr);
  assert.equal(biomeDiagnostics(suppressed).length, 0);
  writeFileSync(scratchPath, virtualInput);
  const unsuppressedName = `biome-unsuppressed-mirror-${index + 1}.json`;
  const unsuppressed = capture(unsuppressedName, command);
  const parsed: unknown = JSON.parse(unsuppressed.stdout);
  assert(object(parsed) && object(parsed.summary));
  assert.equal(
    parsed.summary.unchanged,
    1,
    "external proof selects exactly one file"
  );
  const matching = biomeDiagnostics(unsuppressed).filter(
    (finding) => finding.category === original.rule
  );
  assert.equal(unsuppressed.exit_code, 1);
  assert(
    matching.length > 0,
    `needed retained diagnostic must fire: ${original.identity}`
  );
  assert(
    matching.every(
      (finding) =>
        object(finding.location) && finding.location.path === scratchPath
    )
  );
  assert.equal(readFileSync(path.join(repo, current.path), "utf8"), source);
  const root = codeRoots.find((candidate) =>
    current.path.startsWith(`${candidate}/`)
  );
  assert(root);
  const syntactic = nativeReports.get(`${root}:syntactic`);
  const typeAware = nativeReports.get(`${root}:type-aware`);
  assert(syntactic && typeAware);
  assert(
    ![...syntactic, ...typeAware].some(
      (finding) =>
        /barrel/iu.test(finding.code) || /barrel/iu.test(finding.message)
    ),
    "a firing candidate requires equivalence review"
  );
  return {
    ...original,
    line: undefined,
    baseline_line: original.line,
    live_line: current.line,
    equivalent_native_rule: null,
    native_candidate_rule: "oxc/no-barrel-file",
    native_candidate_options: {
      effective_severity: "deny",
      explicit_options: null,
      documented_default_threshold: 100,
    },
    retained_checker_disposition:
      "retain-original-needed-while-biome-owns-path",
    native_admission_disposition:
      "planned-remove-original-at-atomic-native-admission-no-native-counterpart",
    original_reason_preserved: true,
    currently_retained: true,
    early_deletion: null,
    retained_proof: {
      suppressed_mirror_report: suppressedName,
      unsuppressed_mirror_report: unsuppressedName,
      source_sha256: digest(source),
      unsuppressed_sha256: digest(virtualInput),
      expected_category: original.rule,
      matching_diagnostics: matching.length,
      product_bytes_unchanged: true,
      scratch_discovery_option:
        "--vcs-enabled=false changes discovery only; repository lint rules and options remain unchanged",
    },
    native_proof: {
      syntactic_report: `oxlint-${path.basename(root)}-syntactic.json`,
      type_aware_report: `oxlint-${path.basename(root)}-type-aware.json`,
      combined_type_aware_report: "oxlint-combined-type-aware.json",
      registry_report: "oxlint-rules.json",
      effective_config_report: "oxlint-effective-config.json",
      equivalent_firing_diagnostics: [],
      actual_file_diagnostic_codes: [
        ...new Set(
          typeAware
            .filter((finding) => finding.path === current.path)
            .map((finding) => finding.code)
        ),
      ].sort(),
      rationale:
        "Enabled oxc/no-barrel-file does not fire under the unchanged shipped preset. It checks export-star/module-count threshold behavior, whereas these explicit re-exports trigger Biome. Unrelated diagnostics do not justify a native suppression.",
    },
    producing_commit: measurementCommit,
  };
});
rmSync(path.join(output, "scratch"), { recursive: true, force: true });
const ledger = {
  schema_version: 1,
  ticket: "KRT-BS002",
  baseline_commit: baselineCommit,
  measurement_commit: measurementCommit,
  owned_paths: ownedPaths,
  identity_convention:
    "repository-relative path::Biome rule::one-based occurrence within that path/rule; line is informational",
  drift,
  entries,
};
const expectedIdentities = [
  ...new Set([...baseline, ...live].map((entry) => entry.identity)),
].sort();
const verifyLedger = (value: unknown): void => {
  assert(object(value) && Array.isArray(value.entries));
  assert.equal(value.baseline_commit, baselineCommit);
  assert.equal(value.measurement_commit, measurementCommit);
  assert.deepEqual(
    value.entries
      .map((entry: unknown) => {
        assert(object(entry));
        return entry.identity;
      })
      .sort(),
    expectedIdentities,
    "full directive identity set equality"
  );
  for (const entry of value.entries) {
    assert(object(entry));
    const original = baseline.find((item) => item.identity === entry.identity);
    const current = live.find((item) => item.identity === entry.identity);
    assert(original && current);
    assert.equal(
      entry.original_reason,
      original.original_reason,
      "original reason preservation"
    );
    assert.equal(entry.directive, current.directive);
    assert.equal(
      entry.equivalent_native_rule,
      null,
      "no fabricated counterpart"
    );
    const expected = entries.find((item) => item.identity === entry.identity);
    assert(expected);
    assert.deepEqual(
      entry,
      JSON.parse(JSON.stringify(expected)),
      "all dispositions/proof match fresh diagnostics"
    );
  }
};
verifyLedger(JSON.parse(JSON.stringify(ledger)));
assert.throws(
  () => verifyLedger({ ...ledger, entries: entries.slice(1) }),
  /identity set equality/u
);
assert.throws(
  () =>
    verifyLedger({
      ...ledger,
      entries: entries.map((entry, index) =>
        index === 0
          ? { ...entry, original_reason: "altered reason control" }
          : entry
      ),
    }),
  /original reason preservation/u
);
if (process.argv[5])
  verifyLedger(JSON.parse(readFileSync(process.argv[5], "utf8")));
save("suppressions.json", ledger);
const changesetPath = ".changeset/toolchain-bs-kernel-support-lint.md";
const changeset = readFileSync(path.join(repo, changesetPath), "utf8");
const changedPaths = git("diff", "--name-only", `${baselineCommit}...HEAD`)
  .split("\n")
  .filter(Boolean);
assert(changedPaths.includes(changesetPath));
const publicPackages: string[] = [];
for (const root of ownedPaths) {
  const manifests = files().filter(
    (filename) => filename === `${root}/package.json`
  );
  for (const manifestPath of manifests) {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repo, manifestPath), "utf8")
    );
    assert(object(manifest) && typeof manifest.name === "string");
    if (
      manifest.private !== true &&
      changedPaths.some((filename) => filename.startsWith(`${root}/`))
    ) {
      assert(
        changeset
          .split("---")[1]
          ?.split("\n")
          .includes(`"${manifest.name}": patch`),
        `direct patch entry required: ${manifest.name}`
      );
      publicPackages.push(manifest.name);
    }
  }
}
assert.deepEqual(publicPackages, ["@tuvren/kernel-grpc-client"]);
save("changeset-direct-proof.json", {
  changeset_path: changesetPath,
  contents: changeset,
  packages: publicPackages,
  release_type: "patch",
  base: baselineCommit,
  changed_paths: changedPaths,
});
const changesets = capture("changeset-check.json", [
  "bun",
  "run",
  "changeset:check",
  `--base=${baselineCommit}`,
]);
assert.equal(changesets.exit_code, 0, changesets.stderr);
const typecheck = capture("typecheck.json", ["bun", "run", "typecheck"]);
assert.equal(typecheck.exit_code, 0, typecheck.stderr);
const fullLint = capture("full-lint.json", ["bun", "run", "lint"]);
assert.equal(fullLint.exit_code, 0, fullLint.stderr);
assert.equal(git("rev-parse", "HEAD").trim(), measurementCommit);
assert.equal(
  git("status", "--porcelain=v1"),
  beforeStatus,
  "worktree unchanged"
);
assert.deepEqual(
  productHashes(),
  beforeHashes,
  "every owned file byte remains unchanged"
);
save("assertions.json", {
  status: "pass",
  measurement_commit: measurementCommit,
  baseline_identities: baseline.length,
  live_identities: live.length,
  ledger_identities: entries.length,
  full_expected_identity_set_equality: true,
  original_reasons_preserved: true,
  needed_original_directives_retained: true,
  no_added_biome_directives: true,
  no_fabricated_native_counterparts: true,
  mirror_exact_retained_diagnostic: true,
  native_unix_reports_complete: true,
  combined_and_per_root_diagnostics_equal: true,
  native_diagnostic_count: combinedFindings.length,
  all_five_roots_retain_biome: true,
  negative_controls: {
    missing_entry_rejected: true,
    altered_reason_rejected: true,
  },
  retained_biome_exit_code: retained.exit_code,
  native_baseline_exit_code: combined.exit_code,
  full_lint_exit_code: fullLint.exit_code,
  typecheck_exit_code: typecheck.exit_code,
  changeset_check_exit_code: changesets.exit_code,
  worktree_unchanged: true,
  owned_bytes_unchanged: true,
  early_deletions: [],
  native_suppressions_added: [],
});
process.stdout.write(
  `KRT-BS002: PASS; ${entries.length} needed originals retained; ${combinedFindings.length} native diagnostics remain; no native counterparts.\n`
);
