import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COVERAGE_LIST_IDS,
  findDuplicateEntries,
  readCoverageEntries,
  resolveCoverage,
  runLintGate,
  type CoverageEntry,
  type CoverageListId,
  type LintGateDependencies,
  type LintGateResult,
} from "./biome-lint.js";
import {
  FORMER_ROOT_DELETED_COMMAND,
  FORMER_ROOT_DISCOVERY_COMMAND,
  parseGitFileList,
  removeDeletedFiles,
  selectFormerRootFiles,
} from "./lib/biome-inventory.js";
import { runCommand, type RunCommandResult } from "./lib/command-runner.js";
import { discoverOxcProjects } from "./lib/native-lint-routing.js";
import { loadNxProjectFiles, type NxProjectFile } from "./lib/nx-projects.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIOME_BIN = path.join(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");
const BIOME_CONFIG = path.join(REPO_ROOT, "biome.jsonc");
const COVERAGE_DIR = path.join(REPO_ROOT, "tools/biome-coverage");
const TEST_TMP_ROOT = tmpdir();
const EMPTY_NATIVE_COVERAGE = {
  jsonValidatedFiles: [],
  oxlintFiles: [],
} as const;
const TRAILING_SLASH_PATTERN = /\/$/u;

interface JsonDiagnostic {
  category: string;
  severity: string;
}

interface BiomeJsonReport {
  diagnostics?: JsonDiagnostic[];
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

// biome.jsonc is a JSONC artifact: M6's Oxfmt output emits trailing commas,
// which strict JSON.parse rejects. Read only that artifact with the runtime
// JSONC parser; every other read in this file stays strict JSON.
function parseJsonc<T>(text: string): T {
  const bun = (
    globalThis as {
      Bun?: { JSONC?: { parse: (value: string) => unknown } };
    }
  ).Bun;
  if (!bun?.JSONC) {
    throw new Error("Bun.JSONC is unavailable in this runtime");
  }
  return bun.JSONC.parse(text) as T;
}

let inventoryCache: Promise<string[]> | undefined;

async function collectFormerRootInventory(): Promise<string[]> {
  inventoryCache ??= (async () => {
    const discovery = await runCommand(FORMER_ROOT_DISCOVERY_COMMAND, {
      captureOutput: true,
      cwd: REPO_ROOT,
    });
    expect(discovery.code).toBe(0);
    const deletion = await runCommand(FORMER_ROOT_DELETED_COMMAND, {
      captureOutput: true,
      cwd: REPO_ROOT,
    });
    expect(deletion.code).toBe(0);
    return selectFormerRootFiles(
      REPO_ROOT,
      removeDeletedFiles(
        parseGitFileList(discovery.stdout),
        parseGitFileList(deletion.stdout)
      )
    );
  })();
  return await inventoryCache;
}

function writeCoverageLists(
  directory: string,
  overrides: Partial<Record<CoverageListId, string[]>>
): void {
  for (const id of COVERAGE_LIST_IDS) {
    writeFileSync(
      path.join(directory, `${id}.json`),
      `${JSON.stringify(overrides[id] ?? [], null, 2)}\n`
    );
  }
}

function projectFile(
  name: string,
  root: string,
  lintCommand: string
): NxProjectFile {
  const project = {
    name,
    root,
    targets: {
      lint: {
        executor: "nx:run-commands",
        options: { command: lintCommand },
      },
    },
  };
  return { name, path: `${root}/project.json`, project };
}

function recordingRunCommand(
  candidates: string[],
  commands: string[][]
): LintGateDependencies["runCommand"] {
  return (command): Promise<RunCommandResult> => {
    commands.push([...command]);
    if (command[0] === "git") {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: command.includes("--deleted")
          ? ""
          : candidates.map((candidate) => `${candidate}\0`).join(""),
      });
    }
    if (command.includes("--debug=files")) {
      const typeAwareIndex = command.indexOf("--type-aware");
      const root = command[typeAwareIndex + 1];
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout:
          root === undefined
            ? ""
            : `${root.replace(TRAILING_SLASH_PATTERN, "")}/src/index.ts\n`,
      });
    }
    return Promise.resolve({ code: 0, stderr: "", stdout: "" });
  };
}

function runBiomeCheck(configPath: string, files: string[]): JsonDiagnostic[] {
  const result = spawnSync(
    process.execPath,
    [
      BIOME_BIN,
      "check",
      ...files,
      `--config-path=${configPath}`,
      "--reporter=json",
      "--max-diagnostics=none",
      "--colors=off",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const report = parseJson<BiomeJsonReport>(result.stdout);
  return report.diagnostics ?? [];
}

function writeFeatureProbe(
  directory: string,
  reenableFeatures: boolean
): { configPath: string; files: string[] } {
  const sourcePath = path.join(directory, "unsorted.ts");
  const jsonPath = path.join(directory, "messy.json");
  writeFileSync(
    sourcePath,
    [
      'import { z } from "zod";',
      'import { readFileSync } from "node:fs";',
      "",
      "const   bad   = {   a:1,   b:2   };",
      "console.log(readFileSync, z, bad);",
      "",
    ].join("\n")
  );
  writeFileSync(jsonPath, '{ "a":1,   "b":2 }\n');

  const config: Record<string, unknown> = {
    assist: { enabled: reenableFeatures },
    extends: [BIOME_CONFIG],
    files: { includes: ["**"] },
    formatter: { enabled: reenableFeatures },
    vcs: { enabled: false },
  };
  const configPath = path.join(
    directory,
    reenableFeatures ? "features-on.jsonc" : "features-off.jsonc"
  );
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, files: [sourcePath, jsonPath] };
}

describe("biome coverage inventory", () => {
  test("dropping a directory entry surfaces missing coverage", () => {
    const entries = readCoverageEntries(COVERAGE_DIR).filter(
      (entry) => !(entry.list === "residual" && entry.path === "spec")
    );
    const resolution = resolveCoverage(
      ["spec/core/example.ts", "biome.jsonc"],
      entries,
      EMPTY_NATIVE_COVERAGE
    );
    expect(resolution.missing).toEqual(["spec/core/example.ts"]);
  });

  test("a duplicated assignment is rejected", () => {
    const entries: CoverageEntry[] = [
      { list: "bq", path: "typescript/kernel/runtime" },
      { list: "bt", path: "typescript/kernel/runtime" },
    ];
    expect(findDuplicateEntries(entries)).toEqual([
      { lists: ["bq", "bt"], path: "typescript/kernel/runtime" },
    ]);
    expect(
      resolveCoverage(
        ["typescript/kernel/runtime/src/index.ts"],
        entries,
        EMPTY_NATIVE_COVERAGE
      ).duplicates
    ).toEqual([{ lists: ["bq", "bt"], path: "typescript/kernel/runtime" }]);
  });

  test("a broad residual directory subtracts a narrower group", () => {
    const entries: CoverageEntry[] = [
      { list: "residual", path: "tools" },
      { list: "bu", path: "tools/scripts/lib" },
    ];
    const resolution = resolveCoverage(
      ["tools/scripts/lib/a.ts", "tools/scripts/b.ts", "tools/run-nx.mjs"],
      entries,
      EMPTY_NATIVE_COVERAGE
    );
    expect(resolution.missing).toEqual([]);
    expect(resolution.duplicates).toEqual([]);
    expect(resolution.perList.get("bu")).toEqual(["tools/scripts/lib/a.ts"]);
    expect(resolution.perList.get("residual")).toEqual([
      "tools/run-nx.mjs",
      "tools/scripts/b.ts",
    ]);
  });

  test("an explicit source protection is accounted without validated credit", () => {
    const protectedFile = "project/generated/data.json";
    const resolution = resolveCoverage([protectedFile], [], {
      jsonValidatedFiles: [],
      oxlintFiles: [],
      protectedFiles: [protectedFile],
    });

    expect(resolution.missing).toEqual([]);
    expect(resolution.protectedFiles).toEqual([protectedFile]);
    expect(resolution.jsonValidatedFiles).toEqual([]);
  });

  test("editing one list leaves every other list unchanged", async () => {
    const inventory = await collectFormerRootInventory();
    const base = readCoverageEntries(COVERAGE_DIR);
    const before = resolveCoverage(inventory, base, EMPTY_NATIVE_COVERAGE);
    const edited = base.filter((entry) => entry.list !== "bq");
    const after = resolveCoverage(inventory, edited, EMPTY_NATIVE_COVERAGE);

    for (const id of COVERAGE_LIST_IDS) {
      if (id === "bq") {
        continue;
      }
      expect(after.perList.get(id), id).toEqual(before.perList.get(id));
    }
    expect(after.missing.length).toBeGreaterThan(0);
  });
});

describe("biome coverage routing", () => {
  test("empty lists skip Biome while the surface gate and switched OXC targets run", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-routing-")
    );
    try {
      writeCoverageLists(directory, { bq: [], residual: ["src"] });
      const commands: string[][] = [];
      const result: LintGateResult = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [
          projectFile(
            "kernel-contract-protocol",
            "typescript/kernel/protocol",
            "bunx --bun oxlint --type-aware typescript/kernel/protocol"
          ),
        ],
        repoRoot: REPO_ROOT,
        runCommand: recordingRunCommand(
          [
            "src/a.ts",
            "typescript/kernel/grpc-client/tsconfig.kernel-interop.generated.json",
            "typescript/kernel/protocol/src/index.ts",
          ],
          commands
        ),
      });

      expect(result.failed).toBe(false);
      expect(result.biomeRuns.map((run) => run.list)).toEqual(["residual"]);
      expect(result.surfaceGateCode).toBe(0);
      expect(result.oxcRuns.map((run) => run.target)).toEqual([
        "kernel-contract-protocol:lint",
      ]);
      expect(result.protectedFiles).toEqual([
        "typescript/kernel/grpc-client/tsconfig.kernel-interop.generated.json",
      ]);
      expect(
        commands.some((command) =>
          command.join(" ").includes("kraken-surface-gate")
        )
      ).toBe(true);
      expect(
        commands.some((command) =>
          command.join(" ").includes("kernel-contract-protocol:lint")
        )
      ).toBe(true);
      for (const command of commands) {
        if (!command.includes(BIOME_BIN)) {
          continue;
        }
        const lintIndex = command.indexOf("lint");
        expect(lintIndex).toBeGreaterThanOrEqual(0);
        expect(command.slice(lintIndex + 1).length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("missing coverage fails before any Biome or surface run", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-missing-")
    );
    try {
      writeCoverageLists(directory, {});
      const commands: string[][] = [];
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [],
        repoRoot: REPO_ROOT,
        runCommand: recordingRunCommand(["src/a.ts"], commands),
      });

      expect(result.failed).toBe(true);
      expect(result.missing).toEqual(["src/a.ts"]);
      expect(result.biomeRuns).toEqual([]);
      expect(result.surfaceGateCode).toBeUndefined();
      expect(commands.length).toBe(2);
      expect(commands.every((command) => command[0] === "git")).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a discovery failure fails the gate before any Biome or surface run", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-failed-")
    );
    try {
      writeCoverageLists(directory, { residual: ["src"] });
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [],
        repoRoot: REPO_ROOT,
        runCommand: (command) => {
          if (command[0] === "git") {
            return Promise.resolve({
              code: 2,
              stderr: "fatal",
              stdout: "biome.jsonc\0",
            });
          }
          return Promise.resolve({ code: 0, stderr: "", stdout: "" });
        },
      });

      expect(result.failed).toBe(true);
      expect(result.discoveryError).toContain("exited with code 2");
      expect(result.inventorySize).toBe(0);
      expect(result.biomeRuns).toEqual([]);
      expect(result.surfaceGateCode).toBeUndefined();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("an empty discovery result fails the gate", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-empty-")
    );
    try {
      writeCoverageLists(directory, { residual: ["src"] });
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [],
        repoRoot: REPO_ROOT,
        runCommand: recordingRunCommand([], []),
      });

      expect(result.failed).toBe(true);
      expect(result.discoveryError).toBe("former-root inventory is empty");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a migrated project never receives retained Biome lint", async () => {
    const directory = mkdtempSync(path.join(TEST_TMP_ROOT, "biome-lint-oxc-"));
    try {
      writeCoverageLists(directory, { residual: ["src"] });
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [
          projectFile(
            "kernel-contract-protocol",
            "typescript/kernel/protocol",
            "bunx --bun oxlint --type-aware typescript/kernel/protocol"
          ),
        ],
        repoRoot: REPO_ROOT,
        runCommand: recordingRunCommand(
          ["src/a.ts", "typescript/kernel/protocol/src/index.ts"],
          []
        ),
      });

      expect(result.failed).toBe(false);
      expect(result.oxlintFiles).toEqual([
        "typescript/kernel/protocol/src/index.ts",
      ]);
      expect(result.missing).toEqual([]);
      expect(result.biomeRuns.flatMap((run) => run.files)).toEqual([
        "src/a.ts",
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("an empty native Oxlint selection fails before coverage is credited", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-oxc-empty-")
    );
    try {
      writeCoverageLists(directory, { bq: ["typescript/kernel/protocol"] });
      const commands: string[][] = [];
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [
          projectFile(
            "kernel-contract-protocol",
            "typescript/kernel/protocol",
            "bunx --bun oxlint --type-aware typescript/kernel/protocol"
          ),
        ],
        repoRoot: REPO_ROOT,
        runCommand: (command) => {
          commands.push([...command]);
          if (command[0] === "git") {
            return Promise.resolve({
              code: 0,
              stderr: "",
              stdout: command.includes("--deleted")
                ? ""
                : "typescript/kernel/protocol/src/index.ts\0",
            });
          }
          return Promise.resolve({ code: 0, stderr: "", stdout: "" });
        },
      });

      expect(result.failed).toBe(true);
      expect(result.discoveryError).toContain("Oxlint file selection");
      expect(commands).toHaveLength(3);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("JSON source and Oxfmt failures both fail the root lint gate", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-native-")
    );
    try {
      writeCoverageLists(directory, { residual: ["src"] });
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [],
        repoRoot: REPO_ROOT,
        runCommand: (command) => {
          if (command[0] === "git") {
            return Promise.resolve({
              code: 0,
              stderr: "",
              stdout: command.includes("--deleted") ? "" : "src/a.ts\0",
            });
          }
          const failed =
            command.includes("tools/scripts/json-source-check.ts") ||
            command.includes("format:check");
          return Promise.resolve({
            code: failed ? 1 : 0,
            stderr: "",
            stdout: "",
          });
        },
      });

      expect(result.failed).toBe(true);
      expect(result.jsonSourceGateCode).toBe(1);
      expect(result.formatGateCode).toBe(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("formatter-ignored JSON receives native source coverage from the actual selection", async () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-json-selection-")
    );
    try {
      writeCoverageLists(directory, {});
      const files = [
        "project/.alchemy/config.json",
        "project/.open-next/config.json",
        "project/.wrangler/config.json",
        "project/.yarn/config.json",
      ];
      const result = await runLintGate({
        coverageDir: directory,
        listProjectFiles: () => [
          projectFile(
            "json-project",
            "project",
            "bun tools/scripts/json-check.ts --json-only project"
          ),
        ],
        repoRoot: REPO_ROOT,
        runCommand: recordingRunCommand(files, []),
      });

      expect(result.failed).toBe(false);
      expect(result.jsonValidatedFiles).toEqual(files);
      expect(result.protectedFiles).toEqual([]);
      expect(result.missing).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test.each(["dist", "coverage", ".tmp-case"])(
    "root lint rejects code in a JSON-only project even when Nx default inputs exclude %s",
    async (excludedDirectory) => {
      const directory = mkdtempSync(
        path.join(TEST_TMP_ROOT, "biome-lint-json-code-")
      );
      try {
        writeCoverageLists(directory, {});
        const codeFile = `spec/${excludedDirectory}/new.ts`;
        const commands: string[][] = [];
        const result = await runLintGate({
          coverageDir: directory,
          listProjectFiles: () => [
            projectFile(
              "spec-json",
              "spec",
              "bun tools/scripts/json-check.ts --json-only spec"
            ),
          ],
          repoRoot: REPO_ROOT,
          runCommand: recordingRunCommand(
            ["spec/data.json", codeFile],
            commands
          ),
        });

        expect(result.failed).toBe(true);
        expect(result.discoveryError).toContain(
          `JSON-only scope contains code: ${codeFile}`
        );
        expect(
          commands.some((command) => command.includes("spec-json:lint"))
        ).toBe(false);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  );

  test("real project metadata currently discovers no switched OXC target", () => {
    expect(discoverOxcProjects(loadNxProjectFiles(REPO_ROOT))).toEqual([]);
  });
});

describe("biome feature configuration", () => {
  test("cached lint targets include every native JSON checker dependency", () => {
    const config = parseJson<{
      targetDefaults?: { lint?: { inputs?: string[] } };
    }>(readFileSync(path.join(REPO_ROOT, "nx.json"), "utf8"));
    const inputs = config.targetDefaults?.lint?.inputs ?? [];
    expect(inputs).toEqual(
      expect.arrayContaining([
        "{workspaceRoot}/oxfmt.config.ts",
        "{workspaceRoot}/package.json",
        "{workspaceRoot}/bun.lock",
        "{workspaceRoot}/tools/scripts/json-check.ts",
        "{workspaceRoot}/tools/scripts/json-source-check.ts",
        "{workspaceRoot}/tools/scripts/lib/biome-inventory.ts",
        "{workspaceRoot}/tools/scripts/lib/command-runner.ts",
        "{workspaceRoot}/tools/scripts/lib/json-source-integrity.ts",
      ])
    );
  });

  test("biome.jsonc disables formatter and assist without altering lint rules", () => {
    const config = parseJsonc<Record<string, unknown>>(
      readFileSync(BIOME_CONFIG, "utf8")
    );
    expect(config.formatter).toEqual({ enabled: false });
    expect(config.assist).toEqual({ enabled: false });
    expect(config.linter).toBeUndefined();
    expect(config.extends).toEqual(["ultracite-biome/biome/core"]);
  });

  test("biome check reports no formatter or assist diagnostics", () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-features-")
    );
    try {
      const probe = writeFeatureProbe(directory, false);
      const featureDiagnostics = runBiomeCheck(
        probe.configPath,
        probe.files
      ).filter(
        (diagnostic) =>
          diagnostic.category.startsWith("format") ||
          diagnostic.category.startsWith("assist")
      );
      expect(featureDiagnostics).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("mutation control: re-enabling the features reproduces diagnostics", () => {
    const directory = mkdtempSync(
      path.join(TEST_TMP_ROOT, "biome-lint-control-")
    );
    try {
      const probe = writeFeatureProbe(directory, true);
      const featureDiagnostics = runBiomeCheck(
        probe.configPath,
        probe.files
      ).filter(
        (diagnostic) =>
          diagnostic.category.startsWith("format") ||
          diagnostic.category.startsWith("assist")
      );
      expect(featureDiagnostics.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("root lint routes through the coverage runner", () => {
    const manifest = parseJson<{ scripts?: Record<string, string> }>(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
    expect(manifest.scripts?.lint).toBe("bun tools/scripts/biome-lint.ts");
  });
});
