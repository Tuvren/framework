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

const KERNEL_PLAN_PATH = stdio(
  "spec/conformance/kernel/plans/kernel-protocol-extended.json"
);
const KERNEL_PLAN_SCRIPT = "tools/scripts/conformance/generate-kernel-plans.ts";
const CHANGESET_PATH = ".changeset/toolchain-bp-oxc-preparation.md";
const BIOME_PACKAGE_PATTERN = /@biomejs\/biome/u;
const OXFMT_PATTERN = /\boxfmt\b/u;
const TELEMETRY_CHANGESET_PATTERN = /"@tuvren\/telemetry-semconv":\s*patch/u;

interface ArtifactTarget {
  file: string;
  target: string;
  // Complete input set the target declared before M5. The Oxfmt switch only
  // adds inputs, so every pre-M5 value must still be present afterward.
  preservedInputs: string[];
}

const ARTIFACT_TARGETS: ArtifactTarget[] = [
  {
    file: "spec/core/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/spec/core/typespec/**/*",
      "{workspaceRoot}/spec/core/artifacts/**/*",
      "{workspaceRoot}/bun.lock",
    ],
  },
  {
    file: "spec/providers/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/spec/providers/typespec/**/*",
      "{workspaceRoot}/spec/providers/artifacts/**/*",
      "{workspaceRoot}/bun.lock",
    ],
  },
  {
    file: "spec/runners/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/spec/runners/typespec/**/*",
      "{workspaceRoot}/spec/runners/artifacts/**/*",
      "{workspaceRoot}/bun.lock",
    ],
  },
  {
    file: "spec/tools/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/spec/tools/typespec/**/*",
      "{workspaceRoot}/spec/tools/artifacts/**/*",
      "{workspaceRoot}/bun.lock",
    ],
  },
  {
    file: "spec/host/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/spec/host/typespec/**/*",
      "{workspaceRoot}/spec/host/artifacts/**/*",
      "{workspaceRoot}/spec/host/session/typespec/**/*",
      "{workspaceRoot}/spec/host/session/artifacts/**/*",
      "{workspaceRoot}/bun.lock",
    ],
  },
  {
    file: "spec/streaming/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/spec/streaming/typespec/**/*",
      "{workspaceRoot}/spec/streaming/artifacts/**/*",
      "{workspaceRoot}/spec/streaming/sse/typespec/**/*",
      "{workspaceRoot}/spec/streaming/sse/artifacts/**/*",
      "{workspaceRoot}/spec/streaming/resume/typespec/**/*",
      "{workspaceRoot}/spec/streaming/resume/artifacts/**/*",
      "{workspaceRoot}/spec/streaming/ws/typespec/**/*",
      "{workspaceRoot}/spec/streaming/ws/artifacts/**/*",
      "{workspaceRoot}/bun.lock",
    ],
  },
  {
    file: "spec/telemetry/project.json",
    target: "codegen",
    preservedInputs: [
      "default",
      "{workspaceRoot}/tools/scripts/telemetry-codegen.ts",
      "{workspaceRoot}/tools/scripts/lib/**/*",
      "{workspaceRoot}/tools/generators/telemetry/**/*",
    ],
  },
  {
    // Only the evidence-refresh target invokes the changed compatibility
    // formatter; codegen and check in this project remain check-only.
    file: "reports/compatibility/project.json",
    target: "evidence-refresh",
    preservedInputs: [
      "default",
      "^production",
      "{workspaceRoot}/tools/scripts/**/*",
      "{workspaceRoot}/tools/conformance/**/*",
      "{workspaceRoot}/spec/conformance/**/*",
      "{workspaceRoot}/typescript/conformance-adapter/**/*",
      "{workspaceRoot}/typescript/kernel/conformance-adapter/**/*",
      "{workspaceRoot}/typescript/providers/conformance-adapter/**/*",
      "{workspaceRoot}/rust/conformance-adapter/**/*",
      "{workspaceRoot}/rust/kernel-conformance-adapter/**/*",
      "{workspaceRoot}/go/kernel-conformance-adapter/**/*",
      "{workspaceRoot}/python/kernel-conformance-adapter/**/*",
      "{workspaceRoot}/dart/kernel-conformance-adapter/**/*",
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

interface ProjectTarget {
  inputs?: string[];
  options?: { command?: string };
}

interface ProjectManifest {
  targets?: Record<string, ProjectTarget>;
}

function readTarget(
  relativePath: string,
  targetName: string
): { command: string; inputs: string[] } {
  const manifest = JSON.parse(read(relativePath)) as ProjectManifest;
  const target = manifest.targets?.[targetName];
  const command = target?.options?.command;

  if (typeof command !== "string") {
    throw new Error(`${relativePath} does not declare a ${targetName} command`);
  }

  return { command, inputs: target?.inputs ?? [] };
}

function missingInputs(
  inputs: readonly string[],
  preserved: readonly string[]
): string[] {
  return preserved.filter((value) => !inputs.includes(value));
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
  test("artifact targets use Oxfmt and retain every pre-M5 input", () => {
    for (const target of ARTIFACT_TARGETS) {
      const { command, inputs } = readTarget(target.file, target.target);

      if (DIRECT_TYPESPEC_TARGETS.has(target.file)) {
        expect(command, target.file).toMatch(OXFMT_PATTERN);
      }
      expect(command, target.file).not.toMatch(BIOME_PACKAGE_PATTERN);

      expect(
        missingInputs(inputs, target.preservedInputs),
        `${target.file} ${target.target} inputs`
      ).toEqual([]);
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

describe("preserved input controls", () => {
  function targetFor(file: string): ArtifactTarget {
    const target = ARTIFACT_TARGETS.find(
      (candidate) => candidate.file === file
    );
    if (target == null) {
      throw new Error(`${file} is not a declared artifact target`);
    }
    return target;
  }

  function removalControl(file: string, removed: string): void {
    const target = targetFor(file);
    const { inputs } = readTarget(target.file, target.target);

    expect(missingInputs(inputs, target.preservedInputs)).toEqual([]);
    expect(
      missingInputs(
        inputs.filter((value) => value !== removed),
        target.preservedInputs
      )
    ).toEqual([removed]);
  }

  test("removing a core artifact input fails the check", () => {
    removalControl(
      "spec/core/project.json",
      "{workspaceRoot}/spec/core/artifacts/**/*"
    );
  });

  test("removing a host artifact input fails the check", () => {
    removalControl(
      "spec/host/project.json",
      "{workspaceRoot}/spec/host/artifacts/**/*"
    );
  });

  test("removing a streaming artifact input fails the check", () => {
    removalControl(
      "spec/streaming/project.json",
      "{workspaceRoot}/spec/streaming/ws/artifacts/**/*"
    );
  });

  test("removing the telemetry default input fails the check", () => {
    removalControl("spec/telemetry/project.json", "default");
  });

  test("removing the telemetry tooling input fails the check", () => {
    removalControl(
      "spec/telemetry/project.json",
      "{workspaceRoot}/tools/scripts/lib/**/*"
    );
  });

  test("removing a compatibility evidence-refresh input fails the check", () => {
    removalControl(
      "reports/compatibility/project.json",
      "{workspaceRoot}/dart/kernel-conformance-adapter/**/*"
    );
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
