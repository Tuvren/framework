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

// Read-only M3 evidence probe. Run under the repository's loaded direnv environment.
// All outputs go to the explicit external evidence directory; stdin probes never edit source.
const baselineCommit = "f814b9ac82718123e0d23eabb35a9db61aebfacd";
const ownedPaths = ["typescript/kernel/protocol", "typescript/kernel/runtime"];
const rule = "lint/performance/noBarrelFile";
const barrelPattern = /barrel/iu;
const stdinFailurePattern = /contents aren't fixed/u;
const directivePattern =
  /^\s*\/\/ (biome-ignore(?:-all|-start|-end)?)(?:\s+)([^:]+):\s*(.*)$/u;
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
  exit_code: number;
  stdout: string;
  stderr: string;
  stdin_sha256: string | null;
}
const repoArgument = process.argv[2];
const outputArgument = process.argv[3];
assert(
  repoArgument && outputArgument,
  "usage: bun probe.ts REPOSITORY EXTERNAL_OUTPUT [LEDGER_TO_CHECK]"
);
const repo = path.resolve(repoArgument);
const output = path.resolve(outputArgument);
assert(
  output !== repo && !output.startsWith(`${repo}${path.sep}`),
  "outputs must be outside repository"
);
mkdirSync(output, { recursive: true });
const save = (name: string, value: unknown): void => {
  writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
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
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", stdoutFd, stderrFd],
      env: { ...process.env, NO_COLOR: "1", NX_SKIP_NX_CACHE: "true" },
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
    `command failed to execute: ${command.join(" ")}`
  );
  return {
    command,
    exit_code: result.status,
    stdout,
    stderr,
    stdin_sha256:
      input === undefined
        ? null
        : createHash("sha256").update(input).digest("hex"),
  };
};
const git = (...args: string[]): string => {
  const result = run(["git", ...args]);
  assert.equal(result.exit_code, 0, result.stderr);
  return result.stdout;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const diagnostics = (report: Report): Record<string, unknown>[] => {
  const parsed: unknown = JSON.parse(report.stdout);
  assert(
    object(parsed) && Array.isArray(parsed.diagnostics),
    "missing structured diagnostics"
  );
  assert(parsed.diagnostics.every(object), "invalid structured diagnostic");
  return parsed.diagnostics;
};
const collect = (revision?: string): Directive[] => {
  const files =
    revision === undefined
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
        );
  const entries: Directive[] = [];
  for (const filename of [
    ...new Set(files.split("\0").filter(Boolean)),
  ].sort()) {
    const source =
      revision === undefined
        ? readFileSync(path.join(repo, filename), "utf8")
        : git("show", `${revision}:${filename}`);
    const occurrences = new Map<string, number>();
    for (const [index, line] of source.split("\n").entries()) {
      if (!line.includes("biome-ignore")) {
        continue;
      }
      const match = directivePattern.exec(line);
      assert(match, `unrecognized Biome directive ${filename}:${index + 1}`);
      const directiveRule = match[2]?.trim();
      const reason = match[3];
      assert(directiveRule && reason, "directive requires rule and reason");
      const occurrence = (occurrences.get(directiveRule) ?? 0) + 1;
      occurrences.set(directiveRule, occurrence);
      entries.push({
        identity: `${filename}::${directiveRule}::${occurrence}`,
        path: filename,
        line: index + 1,
        directive: line,
        rule: directiveRule,
        original_reason: reason,
      });
    }
  }
  return entries;
};
const beforeStatus = git("status", "--porcelain=v1");
assert(
  beforeStatus
    .split("\n")
    .filter(Boolean)
    .every(
      (line) =>
        line.slice(3) ===
        ".constitution/tasks/epics/EPIC-BQ-kernel-lint-pilot.yaml"
    ),
  "measurement permits only existing lead epic bookkeeping changes"
);
save("preexisting-worktree-status.json", {
  status: beforeStatus,
  note: "Lead-owned epic bookkeeping only; product paths must be clean and status must stay unchanged throughout probe.",
});
const measurementCommit = git("rev-parse", "HEAD").trim();
const baseline = collect(baselineCommit);
const live = collect();
save("inventory.json", {
  baseline_commit: baselineCommit,
  measurement_commit: measurementCommit,
  baseline,
  live,
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
const registry = run(["bunx", "--bun", "oxlint", "--rules", "--format=json"]);
assert.equal(registry.exit_code, 0);
save("oxlint-rules.json", registry);
assert(
  registry.stdout.trim().length > 0,
  "installed rule registry must be nonempty"
);
const registeredRules: unknown = JSON.parse(registry.stdout);
assert(Array.isArray(registeredRules) && registeredRules.every(object));
assert(
  registeredRules.some(
    (item) => item.scope === "oxc" && item.value === "no-barrel-file"
  )
);
const effectiveConfig = run(["bunx", "--bun", "oxlint", "--print-config"]);
save("oxlint-effective-config.json", effectiveConfig);
assert.equal(effectiveConfig.exit_code, 0);
const config: unknown = JSON.parse(effectiveConfig.stdout);
assert(object(config) && object(config.rules));
assert.equal(config.rules["oxc/no-barrel-file"], "deny");
const nativeReports = new Map<string, Record<string, unknown>[]>();
const nativeSummary: unknown[] = [];
for (const root of ownedPaths) {
  const area = path.basename(root);
  const selection = run(["bunx", "--bun", "oxlint", "--debug=files", root]);
  save(`oxlint-${area}-selection.json`, selection);
  assert.equal(selection.exit_code, 0);
  for (const entry of live.filter((item) => item.path.startsWith(`${root}/`))) {
    assert(
      selection.stdout.includes(entry.path),
      `native selection must contain ${entry.path}`
    );
  }
  const retained = run([
    "bunx",
    "--bun",
    "@biomejs/biome",
    "check",
    root,
    "--reporter=json",
    "--max-diagnostics=none",
  ]);
  save(`biome-${area}.json`, retained);
  assert.equal(retained.exit_code, 0, retained.stderr);
  assert.equal(diagnostics(retained).length, 0);
  for (const typeAware of [false, true]) {
    const flavor = typeAware ? "type-aware" : "syntactic";
    const command = [
      "bunx",
      "--bun",
      "oxlint",
      ...(typeAware ? ["--type-aware"] : []),
      "--format=json",
      root,
    ];
    const report = run(command);
    save(`oxlint-${area}-${flavor}.json`, report);
    const findings = diagnostics(report);
    assert.equal(
      report.exit_code,
      1,
      "native lint currently reports known debt with exit 1"
    );
    assert(findings.length > 0);
    assert(
      findings.every(
        (finding) =>
          typeof finding.code === "string" &&
          typeof finding.filename === "string"
      ),
      "backend/config errors are not rule diagnostics"
    );
    assert(
      !findings.some(
        (finding) =>
          barrelPattern.test(String(finding.code)) ||
          barrelPattern.test(String(finding.message))
      )
    );
    nativeReports.set(`${root}:${flavor}`, findings);
    const counts = new Map<string, number>();
    for (const finding of findings) {
      counts.set(
        String(finding.code),
        (counts.get(String(finding.code)) ?? 0) + 1
      );
    }
    nativeSummary.push({
      root,
      flavor,
      exit_code: report.exit_code,
      diagnostics: findings.length,
      by_rule: Object.fromEntries([...counts].sort()),
    });
  }
}
save("native-summary.json", nativeSummary);
const entries = baseline.map((original, index) => {
  const current = live.find((entry) => entry.identity === original.identity);
  assert(current, `needed directive is absent: ${original.identity}`);
  assert.equal(
    current.directive,
    original.directive,
    "original directive must remain byte-identical"
  );
  assert.equal(current.original_reason, original.original_reason);
  assert.equal(
    original.rule,
    rule,
    "new rule requires fresh equivalence review"
  );
  const source = readFileSync(path.join(repo, current.path), "utf8");
  const lines = source.split("\n");
  assert.equal(lines[current.line - 1], original.directive);
  lines[current.line - 1] = ""; // Keep diagnostic line numbers stable without touching source.
  const probe = run(
    [
      "bunx",
      "--bun",
      "@biomejs/biome",
      "check",
      `--stdin-file-path=${current.path}`,
      "--reporter=json",
      "--max-diagnostics=none",
    ],
    lines.join("\n")
  );
  const proofName = `biome-unsuppressed-${index + 1}.json`;
  save(proofName, probe);
  assert.equal(probe.exit_code, 1);
  assert.match(probe.stderr, stdinFailurePattern);
  const scratchPath = path.join(output, "scratch", current.path);
  mkdirSync(path.dirname(scratchPath), { recursive: true });
  const scratchCommand = [
    "bunx",
    "--bun",
    "@biomejs/biome",
    "check",
    `--config-path=${path.join(repo, "biome.jsonc")}`,
    "--vcs-enabled=false",
    scratchPath,
    "--reporter=json",
    "--max-diagnostics=none",
  ];
  writeFileSync(scratchPath, source);
  const suppressedMirror = run(scratchCommand);
  save(`biome-suppressed-mirror-${index + 1}.json`, suppressedMirror);
  assert.equal(suppressedMirror.exit_code, 0);
  assert.equal(diagnostics(suppressedMirror).length, 0);
  const virtualInput = lines.join("\n");
  writeFileSync(scratchPath, virtualInput);
  assert.equal(
    createHash("sha256").update(readFileSync(scratchPath)).digest("hex"),
    probe.stdin_sha256,
    "scratch mirror must equal the virtual stdin bytes"
  );
  const unsuppressedMirror = run(scratchCommand);
  const mirrorProofName = `biome-unsuppressed-mirror-${index + 1}.json`;
  save(mirrorProofName, unsuppressedMirror);
  const parsedMirror: unknown = JSON.parse(unsuppressedMirror.stdout);
  assert(object(parsedMirror) && object(parsedMirror.summary));
  assert.equal(
    parsedMirror.summary.unchanged,
    1,
    "scratch proof must actually select one file"
  );
  const findings = diagnostics(unsuppressedMirror);
  const matching = findings.filter(
    (finding) => finding.category === original.rule
  );
  assert.equal(unsuppressedMirror.exit_code, 1);
  assert(
    matching.length > 0,
    `expected exact retained diagnostic did not fire: ${original.identity}`
  );
  assert(
    matching.every(
      (finding) =>
        object(finding.location) && finding.location.path === scratchPath
    )
  );
  assert.equal(
    readFileSync(path.join(repo, current.path), "utf8"),
    source,
    "actual source bytes must remain unchanged"
  );
  unlinkSync(scratchPath);
  const root = ownedPaths.find((candidate) =>
    current.path.startsWith(`${candidate}/`)
  );
  assert(root);
  const syntactic = nativeReports.get(`${root}:syntactic`);
  const typeAware = nativeReports.get(`${root}:type-aware`);
  assert(syntactic && typeAware);
  return {
    ...original,
    baseline_line: original.line,
    live_line: current.line,
    line: undefined,
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
      virtual_stdin_report: proofName,
      virtual_stdin_sha256: probe.stdin_sha256,
      suppressed_mirror_report: `biome-suppressed-mirror-${index + 1}.json`,
      unsuppressed_mirror_report: mirrorProofName,
      stdin_reporter_limitation:
        "Biome 2.5.14 stdin mode outputs source and a generic contents-aren't-fixed failure rather than rule diagnostics; the byte-identical external mirror supplies the exact category.",
      scratch_discovery_option:
        "--vcs-enabled=false changes discovery only; repository lint rules and options are unchanged",
      expected_category: original.rule,
      matching_diagnostics: matching.length,
      product_bytes_unchanged: true,
    },
    native_proof: {
      syntactic_report: `oxlint-${path.basename(root)}-syntactic.json`,
      type_aware_report: `oxlint-${path.basename(root)}-type-aware.json`,
      registry_report: "oxlint-rules.json",
      effective_config_report: "oxlint-effective-config.json",
      equivalent_firing_diagnostics: [],
      actual_file_diagnostic_codes: [
        ...new Set(
          typeAware
            .filter((finding) => finding.filename === current.path)
            .map((finding) => finding.code)
        ),
      ].sort(),
      rationale:
        "Enabled oxc/no-barrel-file does not fire for this file under the unchanged shipped preset. It checks export-star/module-count threshold behavior, unlike Biome's explicit re-export diagnostic. JSDoc and other unrelated diagnostics do not justify a native suppression.",
    },
    producing_commit: measurementCommit,
  };
});
rmSync(path.join(output, "scratch"), { recursive: true, force: true });
const expectedIdentities = [
  ...new Set([...baseline, ...live].map((entry) => entry.identity)),
].sort();
const ledger = {
  schema_version: 1,
  ticket: "KRT-BQ002",
  baseline_commit: baselineCommit,
  measurement_commit: measurementCommit,
  owned_paths: ownedPaths,
  identity_convention:
    "repository-relative path::Biome rule::one-based occurrence within that path/rule; line is informational",
  drift: {
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
  },
  entries,
};
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
    assert(original && current, "no added or removed Biome directives at M3");
    assert.equal(
      entry.original_reason,
      original.original_reason,
      "original reason preservation"
    );
    assert.equal(entry.directive, original.directive);
    assert.equal(current.directive, original.directive);
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
      "ledger dispositions/proof must match fresh measurement"
    );
  }
};
const normalizedLedger: unknown = JSON.parse(JSON.stringify(ledger));
verifyLedger(normalizedLedger);
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
          ? { ...entry, original_reason: "altered reason negative control" }
          : entry
      ),
    }),
  /original reason preservation/u
);
if (process.argv[4]) {
  verifyLedger(JSON.parse(readFileSync(process.argv[4], "utf8")));
}
save("suppressions.json", ledger);
const fullLint = run(["bun", "run", "lint"]);
save("full-lint.json", fullLint);
const changesets = run([
  "bun",
  "run",
  "changeset:check",
  `--base=${baselineCommit}`,
]);
save("changeset-check.json", changesets);
assert.equal(changesets.exit_code, 0, changesets.stderr);
const changesetPath = ".changeset/toolchain-bq-kernel-lint-pilot.md";
const changeset = readFileSync(path.join(repo, changesetPath), "utf8");
assert(
  git("diff", "--name-only", `${baselineCommit}...HEAD`)
    .split("\n")
    .includes(changesetPath)
);
for (const name of ["@tuvren/kernel-protocol", "@tuvren/kernel-runtime"]) {
  assert(changeset.includes(`"${name}": patch`));
}
save("changeset-direct-proof.json", {
  changeset_path: changesetPath,
  contents: changeset,
  packages: ["@tuvren/kernel-protocol", "@tuvren/kernel-runtime"],
  release_type: "patch",
  base: baselineCommit,
});
const typecheck = run(["bun", "run", "typecheck"]);
save("typecheck.json", typecheck);
assert.equal(typecheck.exit_code, 0, typecheck.stderr);
assert.equal(git("rev-parse", "HEAD").trim(), measurementCommit);
assert.equal(
  git("status", "--porcelain=v1"),
  beforeStatus,
  "probe must not mutate worktree"
);
save("assertions.json", {
  status: fullLint.exit_code === 0 ? "pass" : "fail",
  measurement_commit: measurementCommit,
  baseline_identities: baseline.length,
  live_identities: live.length,
  ledger_identities: entries.length,
  full_expected_identity_set_equality: true,
  original_reasons_preserved: true,
  needed_original_directives_retained: true,
  no_added_biome_directives: true,
  no_fabricated_native_counterparts: true,
  virtual_input_mirror_exact_retained_diagnostic: true,
  negative_controls: {
    missing_entry_rejected: true,
    altered_reason_rejected: true,
  },
  full_lint_exit_code: fullLint.exit_code,
  typecheck_exit_code: typecheck.exit_code,
  changeset_check_exit_code: changesets.exit_code,
  worktree_unchanged: true,
  early_deletions: [],
  native_suppressions_added: [],
});
process.stdout.write(
  `KRT-BQ002: ${fullLint.exit_code === 0 ? "PASS" : "FAIL (full lint)"}; ${entries.length} measured directives retained; exact identity/reason controls pass.\n`
);
assert.equal(
  fullLint.exit_code,
  0,
  "full lint gate must pass for M3 acceptance; inspect full-lint.json"
);
