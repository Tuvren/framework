// KRT-BP003 / ADR-0070. Contract test for the Oxfmt switch in generators and
// artifact targets. It runs the real scripts and reads the real target
// configuration instead of asserting on a mirrored copy of the command lists.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const FORMAT_CALLER_SOURCES = [
  "tools/scripts/conformance/format-generated-json.ts",
  "tools/scripts/telemetry-codegen.ts",
  "tools/scripts/api-freeze-gate.ts",
  "tools/scripts/compatibility-report.ts",
];

const KERNEL_PLAN_PATH = stdio("spec/conformance/kernel/plans/kernel-protocol-extended.json");
const KERNEL_PLAN_SCRIPT = "tools/scripts/conformance/generate-kernel-plans.ts";
const CHANGESET_PATH = ".changeset/toolchain-bp-oxc-preparation.md";
const BIOME_PACKAGE_PATTERN = /@biomejs\/biome/u;
const OXFMT_PATTERN = /\boxfmt\b/u;
const TELEMETRY_CHANGESET_PATTERN = /"@tuvren\/telemetry-semconv":\s*patch/u;

interface ArtifactTarget {
  file: string;
  // Inputs every artifact target must keep declaring in addition to the new
  // Oxfmt config and package pins.
  preservedInputs: string[];
}

const ARTIFACT_TARGETS: ArtifactTarget[] = [
  {
    file: "spec/core/project.json",
    preservedInputs: ["{workspaceRoot}/spec/core/typespec/**/*"],
  },
  {
    file: "spec/providers/project.json",
    preservedInputs: ["{workspaceRoot}/spec/providers/typespec/**/*"],
  },
  {
    file: "spec/runners/project.json",
    preservedInputs: ["{workspaceRoot}/spec/runners/typespec/**/*"],
  },
  {
    file: "spec/tools/project.json",
    preservedInputs: ["{workspaceRoot}/spec/tools/typespec/**/*"],
  },
  {
    file: "spec/host/project.json",
    preservedInputs: [
      "{workspaceRoot}/spec/host/typespec/**/*",
      "{workspaceRoot}/spec/host/session/typespec/**/*",
    ],
  },
  {
    file: "spec/streaming/project.json",
    preservedInputs: [
      "{workspaceRoot}/spec/streaming/typespec/**/*",
      "{workspaceRoot}/spec/streaming/sse/typespec/**/*",
      "{workspaceRoot}/spec/streaming/resume/typespec/**/*",
      "{workspaceRoot}/spec/streaming/ws/typespec/**/*",
    ],
  },
  {
    file: "spec/telemetry/project.json",
    preservedInputs: [
      "{workspaceRoot}/tools/scripts/telemetry-codegen.ts",
      "{workspaceRoot}/tools/generators/telemetry/**/*",
    ],
  },
];

// The six direct TypeSpec targets format in their own command; telemetry is
// the seventh artifact target and formats inside its generator.
const DIRECT_TYPESPEC_TARGETS = new Set(
  ARTIFACT_TARGETS.slice(0, 6).map((target) => target.file)
);

function stdio(relativePath: string): string {
  return path.join(REPO_ROOT, relativePath);
}

function read(relativePath: string): string {
  return readFileSync(stdio(relativePath), "utf8");
}

interface ProjectManifest {
  targets?: {
    codegen?: {
      inputs?: string[];
      options?: { command?: string };
    };
  };
}

function readCodegenTarget(relativePath: string): {
  command: string;
  inputs: string[];
} {
  const manifest = JSON.parse(read(relativePath)) as ProjectManifest;
  const codegen = manifest.targets?.codegen;
  const command = codegen?.options?.command;

  if (typeof command !== "string") {
    throw new Error(`${relativePath} does not declare a codegen command`);
  }

  return { command, inputs: codegen?.inputs ?? [] };
}

function runGenerator(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [KERNEL_PLAN_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe("generator formatter callers", () => {
  test("no caller invokes Biome and every caller invokes Oxfmt", () => {
    for (const source of FORMAT_CALLER_SOURCES) {
      const contents = read(source);
      expect(contents, source).not.toMatch(BIOME_PACKAGE_PATTERN);
      expect(contents, source).toMatch(OXFMT_PATTERN);
    }
  });

  test("telemetry formatting excludes Markdown but keeps a matched JSON path", () => {
    const contents = read("tools/scripts/telemetry-codegen.ts");
    const start = contents.indexOf("async function formatGeneratedOutputs");
    expect(start).toBeGreaterThan(-1);
    const end = contents.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = contents.slice(start, end);

    expect(body).toMatch(OXFMT_PATTERN);
    expect(body).toContain("JSON_OUTPUT_PATH");
    expect(body).toContain("typescriptOutputPath");
    // Markdown is deliberately excluded: the formatter config ignores it and
    // an all-ignored invocation would exit 2.
    expect(body).not.toContain("MARKDOWN_OUTPUT_PATH");
  });

  test("the API snapshot write calls Oxfmt and guards parsed authority", () => {
    const contents = read("tools/scripts/api-freeze-gate.ts");
    expect(contents).not.toMatch(BIOME_PACKAGE_PATTERN);
    expect(contents).toContain("isDeepStrictEqual");
    expect(contents).toContain('"oxfmt"');
  });
});

describe("artifact target configuration", () => {
  test("codegen commands use Oxfmt and retain their artifact inputs", () => {
    for (const target of ARTIFACT_TARGETS) {
      const { command, inputs } = readCodegenTarget(target.file);

      if (DIRECT_TYPESPEC_TARGETS.has(target.file)) {
        expect(command, target.file).toMatch(OXFMT_PATTERN);
      }
      expect(command, target.file).not.toMatch(BIOME_PACKAGE_PATTERN);

      for (const preserved of target.preservedInputs) {
        expect(inputs, `${target.file} inputs`).toContain(preserved);
      }
      if (DIRECT_TYPESPEC_TARGETS.has(target.file)) {
        expect(inputs, `${target.file} inputs`).toContain(
          "{workspaceRoot}/bun.lock"
        );
      }
      // ADR-0070: the formatter config and its package pin are real inputs so
      // a config or version change invalidates the cached artifact.
      expect(inputs, `${target.file} inputs`).toContain(
        "{workspaceRoot}/oxfmt.config.ts"
      );
      expect(inputs, `${target.file} inputs`).toContain(
        "{workspaceRoot}/package.json"
      );
    }
  });
});

describe("kernel plan promotion guard", () => {
  test("the committed plan keeps 44 checks, 10 promoted checks, and resultField assertions", () => {
    const plan = JSON.parse(readFileSync(KERNEL_PLAN_PATH, "utf8")) as {
      checks: Array<{
        assertions: Array<{ kind?: string }>;
        checkId: string;
      }>;
    };
    const generatedFamilies = plan.checks.filter(
      (check) =>
        check.checkId.includes("deterministic_hashing") ||
        check.checkId.includes("schema_roundtrip")
    );
    const promoted = plan.checks.filter(
      (check) => !generatedFamilies.includes(check)
    );
    const assertionKinds = plan.checks.flatMap((check) =>
      check.assertions.map((assertion) => assertion.kind)
    );

    expect(plan.checks.length).toBe(44);
    expect(generatedFamilies.length).toBe(34);
    expect(promoted.length).toBe(10);
    expect(assertionKinds.length).toBe(118);
    expect([...new Set(assertionKinds)]).toEqual(["resultField"]);
  });

  test("--format-only preserves the parsed plan", () => {
    const before = JSON.parse(readFileSync(KERNEL_PLAN_PATH, "utf8"));
    const result = runGenerator(["--format-only"]);

    expect(result.status, result.stderr).toBe(0);
    const after = JSON.parse(readFileSync(KERNEL_PLAN_PATH, "utf8"));
    expect(isDeepStrictEqual(after, before)).toBe(true);
  });

  test("normal generation still refuses to drop promoted checks", () => {
    const before = JSON.parse(readFileSync(KERNEL_PLAN_PATH, "utf8"));
    const result = runGenerator([]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "refusing to overwrite"
    );
    const after = JSON.parse(readFileSync(KERNEL_PLAN_PATH, "utf8"));
    expect(isDeepStrictEqual(after, before)).toBe(true);
  });
});

describe("changeset coverage", () => {
  test("the changeset carries direct patch coverage for telemetry-semconv", () => {
    const contents = read(CHANGESET_PATH);

    expect(contents).toMatch(TELEMETRY_CHANGESET_PATTERN);
  });
});
