import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const GAP_PLAN_SCRIPT = "tools/scripts/epic-af-conformance-gap-plan.ts";
const GAP_PLAN_SCRIPT_PATH = path.join(REPO_ROOT, GAP_PLAN_SCRIPT);
const BIOME_BIN = path.join(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");
const OXLINT_BIN = path.join(REPO_ROOT, "node_modules/oxlint/bin/oxlint");
const OXFMT_BIN = path.join(REPO_ROOT, "node_modules/oxfmt/bin/oxfmt");
const OXLINT_CONFIG = path.join(REPO_ROOT, "oxlint.config.ts");
const OXFMT_CONFIG = path.join(REPO_ROOT, "oxfmt.config.ts");
const TSGOLINT_BIN = path.join(
  REPO_ROOT,
  "node_modules/oxlint-tsgolint/bin/tsgolint.js"
);

// ADR-0070 / KRT-BP001. The exact resolved versions installed by M3. The pins
// are asserted so an unpinned range or an unexpected bump fails the contract.
const OXLINT_PIN = "1.86.0";
const OXFMT_PIN = "0.71.0";
const OXLINT_TSGOLINT_PIN = "7.0.2003";
const ULTRACITE_PIN = "7.12.2";
const ULTRACITE_BIOME_ALIAS = "npm:ultracite@7.4.2";

// The repository-only additions KRT-BP001 layers on top of the shipped presets.
const CONSTITUTION_IGNORE = ".constitution/**";
const FORMATTER_EXCLUDED_TYPES = [
  "**/*.md",
  "**/*.mdx",
  "**/*.yaml",
  "**/*.yml",
  "**/*.toml",
];

// TS1354: "'readonly' type modifier is only permitted on array and tuple
// literal types." The measured declaration used `readonly Array<...>`, which
// oxfmt refuses to format. The TypeScript compiler reports it as a semantic
// grammar diagnostic, not as a parse or syntactic diagnostic.
const READONLY_ARRAY_GRAMMAR_ERROR = 1354;

interface GrammarDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

interface OxlintConfigLike {
  extends?: unknown[];
  ignorePatterns?: string[];
  [key: string]: unknown;
}

interface OxfmtConfigLike {
  ignorePatterns?: string[];
  [key: string]: unknown;
}

interface OxlintJsonDiagnostic {
  code?: string;
  message?: string;
}

interface OxlintJsonReport {
  diagnostics?: OxlintJsonDiagnostic[];
  number_of_files?: number;
  rules?: Record<string, unknown>;
  [key: string]: unknown;
}

function readonlyArrayGrammarDiagnostics(): GrammarDiagnostic[] {
  const program = ts.createProgram([GAP_PLAN_SCRIPT_PATH], {
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });

  return program
    .getSemanticDiagnostics()
    .filter((diagnostic) => diagnostic.code === READONLY_ARRAY_GRAMMAR_ERROR)
    .map((diagnostic) => {
      const position =
        diagnostic.start !== undefined && diagnostic.file !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;

      return {
        code: diagnostic.code,
        line: (position?.line ?? -1) + 1,
        column: (position?.character ?? -1) + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      };
    });
}

function runBun(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function printConfig(args: string[]): Record<string, unknown> {
  const result = runBun([OXLINT_BIN, ...args, "--print-config"]);
  expect(result.status, result.stderr).toBe(0);
  return parseJson<Record<string, unknown>>(result.stdout);
}

function collectConstitutionDigests(directory: string): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        digests.set(
          path.relative(REPO_ROOT, full),
          createHash("sha256").update(readFileSync(full)).digest("hex")
        );
      }
    }
  };
  walk(directory);
  return digests;
}

function sortedEntries(digests: Map<string, string>): [string, string][] {
  return [...digests.entries()].sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function parseBunLock(text: string): unknown {
  const bun = (
    globalThis as {
      Bun?: { JSONC?: { parse: (value: string) => unknown } };
    }
  ).Bun;
  if (!bun?.JSONC) {
    throw new Error("Bun.JSONC is unavailable in this runtime");
  }
  return bun.JSONC.parse(text);
}

describe("oxc toolchain pins", () => {
  test("manifest pins the OXC binaries and latest ultracite exactly", () => {
    const manifest = parseJson<{ devDependencies?: Record<string, string> }>(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );

    expect(manifest.devDependencies?.oxlint).toBe(OXLINT_PIN);
    expect(manifest.devDependencies?.oxfmt).toBe(OXFMT_PIN);
    expect(manifest.devDependencies?.["oxlint-tsgolint"]).toBe(
      OXLINT_TSGOLINT_PIN
    );
    expect(manifest.devDependencies?.ultracite).toBe(ULTRACITE_PIN);
  });

  test("manifest keeps the retained Biome preset behind its alias", () => {
    const manifest = parseJson<{ devDependencies?: Record<string, string> }>(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );

    expect(manifest.devDependencies?.["ultracite-biome"]).toBe(
      ULTRACITE_BIOME_ALIAS
    );
  });

  test("lockfile resolves every pin without moving the Biome alias", () => {
    const lock = parseBunLock(
      readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8")
    ) as {
      workspaces?: Record<string, { devDependencies?: Record<string, string> }>;
    };
    const workspaceDependencies = lock.workspaces?.[""]?.devDependencies ?? {};

    expect(workspaceDependencies.oxlint).toBe(OXLINT_PIN);
    expect(workspaceDependencies.oxfmt).toBe(OXFMT_PIN);
    expect(workspaceDependencies["oxlint-tsgolint"]).toBe(OXLINT_TSGOLINT_PIN);
    expect(workspaceDependencies.ultracite).toBe(ULTRACITE_PIN);
    expect(workspaceDependencies["ultracite-biome"]).toBe(
      ULTRACITE_BIOME_ALIAS
    );
  });

  test("the type-aware backend resolved to the pinned version", () => {
    const backendManifest = parseJson<{ version?: string }>(
      readFileSync(
        path.join(REPO_ROOT, "node_modules/oxlint-tsgolint/package.json"),
        "utf8"
      )
    );

    expect(backendManifest.version).toBe(OXLINT_TSGOLINT_PIN);
    expect(existsSync(TSGOLINT_BIN)).toBe(true);
  });
});

describe("oxc configuration contract", () => {
  test("oxlint config forwards the shipped preset verbatim with declared ignores", async () => {
    const core = (await import("ultracite/oxlint/core")).default as
      | OxlintConfigLike
      | undefined;
    const config = (
      (await import(pathToFileURL(OXLINT_CONFIG).href)) as {
        default: OxlintConfigLike;
      }
    ).default;

    expect(core).toBeDefined();
    // The preset is inherited verbatim: every key it ships is present at the
    // root with an identical value, and the only local change is the
    // repository-only `.constitution/**` ignore addition.
    expect(Object.keys(config).sort()).toEqual(Object.keys(core ?? {}).sort());
    for (const key of Object.keys(core ?? {})) {
      if (key === "ignorePatterns") {
        continue;
      }
      expect(config[key], key).toEqual(core?.[key]);
    }
    expect(config.ignorePatterns).toEqual([
      ...(core?.ignorePatterns ?? []),
      CONSTITUTION_IGNORE,
    ]);
  });

  test("oxfmt config spreads the shipped preset and excludes non-TS/JSON", async () => {
    const preset = (await import("ultracite/oxfmt")).default as
      | OxfmtConfigLike
      | undefined;
    const config = (
      (await import(pathToFileURL(OXFMT_CONFIG).href)) as {
        default: OxfmtConfigLike;
      }
    ).default;

    expect(preset).toBeDefined();
    expect(Object.keys(config).sort()).toEqual(
      Object.keys(preset ?? {}).sort()
    );
    for (const key of Object.keys(preset ?? {})) {
      if (key === "ignorePatterns") {
        continue;
      }
      expect(config[key], key).toEqual(preset?.[key]);
    }

    const expectedIgnores = [
      ...(preset?.ignorePatterns ?? []),
      CONSTITUTION_IGNORE,
      ...FORMATTER_EXCLUDED_TYPES,
    ];
    expect(config.ignorePatterns).toEqual(expectedIgnores);
    for (const pattern of [CONSTITUTION_IGNORE, ...FORMATTER_EXCLUDED_TYPES]) {
      expect(config.ignorePatterns, pattern).toContain(pattern);
    }
  });

  test("the entire effective oxlint config matches the shipped preset", async () => {
    const core = (await import("ultracite/oxlint/core")).default as unknown;
    const scratch = mkdtempSync(path.join(tmpdir(), "oxc-print-config-"));
    try {
      const coreConfigPath = path.join(scratch, "core.json");
      writeFileSync(coreConfigPath, JSON.stringify(core));

      const ours = printConfig([]);
      const reference = printConfig(["-c", coreConfigPath]);

      // Every effective policy field must be inherited verbatim: full rule
      // tuples (severity and options), env, plugins, settings, categories,
      // globals and the preset's own overrides. Only the deliberately added
      // ignore patterns may differ from a direct load of the preset.
      const policyKeys = [
        ...new Set([...Object.keys(reference), ...Object.keys(ours)]),
      ]
        .filter((key) => key !== "ignorePatterns")
        .sort();
      for (const key of policyKeys) {
        expect(ours[key], `effective ${key}`).toEqual(reference[key]);
      }

      expect(ours.ignorePatterns).toEqual([
        ...((reference.ignorePatterns as string[] | undefined) ?? []),
        CONSTITUTION_IGNORE,
      ]);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  test("the formatter excludes Markdown, YAML, TOML and .constitution", () => {
    const excluded = [
      "README.md",
      "devenv.yaml",
      "Cargo.toml",
      ".constitution/tech-spec/stack.yaml",
    ];
    for (const relative of excluded) {
      const result = runBun([
        OXFMT_BIN,
        "-c",
        OXFMT_CONFIG,
        "--check",
        relative,
      ]);
      expect(result.status, `${relative}: ${result.stdout}`).toBe(2);
    }

    const included = ["oxlint.config.ts", "package.json"];
    for (const relative of included) {
      const result = runBun([
        OXFMT_BIN,
        "-c",
        OXFMT_CONFIG,
        "--check",
        relative,
      ]);
      expect(result.status, relative).not.toBe(2);
    }
  });

  test("oxlint inspects the gap-plan source without grammar failure", () => {
    const result = runBun([OXLINT_BIN, "--format=json", GAP_PLAN_SCRIPT]);
    const report = parseJson<OxlintJsonReport>(result.stdout);

    expect(report.number_of_files).toBe(1);
    for (const diagnostic of report.diagnostics ?? []) {
      // A parse/grammar failure carries no rule code; every reported diagnostic
      // here must be a rule diagnostic instead.
      expect(diagnostic.code, JSON.stringify(diagnostic)).toBeTruthy();
    }
  });

  test("neither OXC binary writes under .constitution", () => {
    const constitutionRoot = path.join(REPO_ROOT, ".constitution");
    const before = collectConstitutionDigests(constitutionRoot);
    expect(before.size).toBeGreaterThan(0);

    runBun([OXFMT_BIN, "-c", OXFMT_CONFIG, "--check", "."]);
    runBun([OXLINT_BIN, "--silent", "--no-error-on-unmatched-pattern", "."]);

    const after = collectConstitutionDigests(constitutionRoot);
    expect(sortedEntries(after)).toEqual(sortedEntries(before));
  });
});

describe("oxc preparation grammar contract", () => {
  test("the gap-plan script has no readonly-array grammar error", () => {
    expect(readonlyArrayGrammarDiagnostics()).toEqual([]);
  });

  test("the gap-plan freshness check succeeds", () => {
    const result = spawnSync(
      process.execPath,
      ["run", "docs:af-gap-plan:check"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
  });

  test("retained Biome inspects the gap-plan script without grammar failure", () => {
    const result = spawnSync(
      process.execPath,
      [BIOME_BIN, "lint", GAP_PLAN_SCRIPT, "--reporter=json", "--colors=off"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    const report = parseJson<{ diagnostics?: unknown[] }>(result.stdout);
    expect(result.status, result.stderr).toBe(0);
    expect(report.diagnostics ?? []).toEqual([]);
  });
});
