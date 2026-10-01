import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const WHITESPACE_PATTERN = /\s/;
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIOME_BIN = path.join(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");
const ALIAS_SPEC = "npm:ultracite@7.4.2";
const ALIAS_PRESET_EXPORT = "ultracite-biome/biome/core";
// Captured from the retained un-aliased ultracite@7.4.2 preset before the
// alias transition. Immutable evidence: the alias must keep resolving to it.
const BASELINE_PRESET_SHA256 =
  "5254ab559d5d2841d6563fcebee5a54c7f31bcdf5b8b0949f16d4e5689571782";
const BASELINE_ALIAS_INTEGRITY =
  "sha512-NjpvM78XgyVPCAw1qSlOnPYFcH4Z7z49Xm0xZdL7Z73f1iAQ/dHttBbN/feMkJ0JDcjsMEWNeEX97wQ45UQHHw==";
const PROBE_SOURCE = `var unusedVar = 1;
function bad() {
  debugger;
}
const x: any = 1;
if (x == null) {
  console.log("hi");
}
export default bad;
`;

interface NormalizedDiagnostic {
  category: string;
  end: { column: number; line: number };
  message: string;
  path: string;
  severity: string;
  start: { column: number; line: number };
}

// Captured from the retained un-aliased ultracite@7.4.2 preset on PROBE_SOURCE.
const BASELINE_PROBE_DIAGNOSTICS: NormalizedDiagnostic[] = [
  {
    category: "lint/suspicious/noVar",
    end: { column: 18, line: 1 },
    message: "Use let or const instead of var.",
    path: "probe.ts",
    severity: "error",
    start: { column: 1, line: 1 },
  },
  {
    category: "lint/correctness/noUnusedVariables",
    end: { column: 14, line: 1 },
    message: "This variable unusedVar is unused.",
    path: "probe.ts",
    severity: "error",
    start: { column: 5, line: 1 },
  },
  {
    category: "lint/suspicious/noDebugger",
    end: { column: 12, line: 3 },
    message: "This is an unexpected use of the debugger statement.",
    path: "probe.ts",
    severity: "error",
    start: { column: 3, line: 3 },
  },
  {
    category: "lint/suspicious/noExplicitAny",
    end: { column: 13, line: 5 },
    message: "Unexpected any. Specify a different type.",
    path: "probe.ts",
    severity: "error",
    start: { column: 10, line: 5 },
  },
];

function stripJsonc(text: string): string {
  let withoutComments = "";
  let index = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (index < text.length) {
    const current = text[index] ?? "";
    const next = text[index + 1];
    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        withoutComments += current;
      }
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (inString) {
      withoutComments += current;
      if (current === "\\") {
        withoutComments += next ?? "";
        index += 2;
        continue;
      }
      if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (current === '"') {
      inString = true;
      withoutComments += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    withoutComments += current;
    index += 1;
  }

  let withoutTrailingCommas = "";
  let inTrailingString = false;
  for (let cursor = 0; cursor < withoutComments.length; cursor += 1) {
    const current = withoutComments[cursor] ?? "";
    if (inTrailingString) {
      withoutTrailingCommas += current;
      if (current === "\\") {
        withoutTrailingCommas += withoutComments[cursor + 1] ?? "";
        cursor += 1;
        continue;
      }
      if (current === '"') {
        inTrailingString = false;
      }
      continue;
    }
    if (current === '"') {
      inTrailingString = true;
      withoutTrailingCommas += current;
      continue;
    }
    if (current === ",") {
      let probe = cursor + 1;
      while (
        probe < withoutComments.length &&
        WHITESPACE_PATTERN.test(withoutComments[probe] ?? "")
      ) {
        probe += 1;
      }
      const following = withoutComments[probe];
      if (following === "}" || following === "]") {
        continue;
      }
    }
    withoutTrailingCommas += current;
  }
  return withoutTrailingCommas;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function normalizePreset(presetPath: string): {
  canonicalBytes: number;
  sha256: string;
} {
  const parsed = JSON.parse(stripJsonc(readFileSync(presetPath, "utf8"))) as {
    linter?: { enabled?: unknown; rules?: unknown };
    overrides?: { includes?: unknown; linter?: { rules?: unknown } }[];
  };
  const overrides = Array.isArray(parsed.overrides) ? parsed.overrides : [];
  const normalized = sortValue({
    linter: {
      enabled: parsed.linter?.enabled ?? null,
      rules: parsed.linter?.rules ?? {},
    },
    overrides: overrides.map((entry) => ({
      includes: entry.includes ?? [],
      rules: entry.linter?.rules ?? {},
    })),
  });
  const canonical = JSON.stringify(normalized);
  return {
    canonicalBytes: canonical.length,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

function normalizeDiagnostics(
  report: unknown,
  virtualPath: string
): NormalizedDiagnostic[] {
  const diagnostics = (report as { diagnostics?: unknown[] }).diagnostics ?? [];
  const normalized = diagnostics.map((raw) => {
    const entry = raw as {
      category?: string;
      location?: {
        end?: { column?: number; line?: number };
        path?: string;
        start?: { column?: number; line?: number };
      };
      message?: string;
      severity?: string;
    };
    const location = entry.location ?? {};
    return {
      category: entry.category ?? "",
      message: entry.message ?? "",
      severity: entry.severity ?? "",
      path: virtualPath,
      start: {
        column: location.start?.column ?? 0,
        line: location.start?.line ?? 0,
      },
      end: {
        column: location.end?.column ?? 0,
        line: location.end?.line ?? 0,
      },
    } satisfies NormalizedDiagnostic;
  });
  normalized.sort((left, right) => {
    const leftKey = `${left.path}:${left.start.line}:${left.start.column}:${left.category}:${left.severity}:${left.message}`;
    const rightKey = `${right.path}:${right.start.line}:${right.start.column}:${right.category}:${right.severity}:${right.message}`;
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
  return normalized;
}

function runProbe(presetPath: string): NormalizedDiagnostic[] {
  const directory = mkdtempSync(path.join(tmpdir(), "biome-alias-"));
  try {
    const probePath = path.join(directory, "probe.ts");
    const configPath = path.join(directory, "biome.jsonc");
    writeFileSync(probePath, PROBE_SOURCE);
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          extends: [presetPath],
          files: { includes: ["**"] },
          vcs: { enabled: false },
        },
        null,
        2
      )}\n`
    );
    const result = spawnSync(
      process.execPath,
      [
        BIOME_BIN,
        "lint",
        probePath,
        `--config-path=${configPath}`,
        "--reporter=json",
        "--max-diagnostics=none",
        "--colors=off",
      ],
      { encoding: "utf8" }
    );
    return normalizeDiagnostics(JSON.parse(result.stdout), "probe.ts");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("biome alias pin", () => {
  test("manifest pins the retained biome preset through an npm alias", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies?.["ultracite-biome"]).toBe(ALIAS_SPEC);
    expect(manifest.dependencies?.["ultracite-biome"]).toBeUndefined();
  });

  test("lockfile resolves the alias to the pinned preset", () => {
    const lock = JSON.parse(
      stripJsonc(readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8"))
    ) as {
      packages?: Record<string, unknown[]>;
      workspaces?: Record<string, { devDependencies?: Record<string, string> }>;
    };
    expect(lock.workspaces?.[""]?.devDependencies?.["ultracite-biome"]).toBe(
      ALIAS_SPEC
    );
    const aliasEntry = lock.packages?.["ultracite-biome"];
    expect(aliasEntry?.[0]).toBe("ultracite@7.4.2");
    expect(aliasEntry?.[3]).toBe(BASELINE_ALIAS_INTEGRITY);
  });

  test("biome.jsonc extends the alias export", () => {
    const config = JSON.parse(
      stripJsonc(readFileSync(path.join(REPO_ROOT, "biome.jsonc"), "utf8"))
    ) as { extends?: string[] };
    expect(config.extends).toEqual([ALIAS_PRESET_EXPORT]);
  });

  test("alias preset preserves the retained rule and severity set", () => {
    const presetPath = createRequire(import.meta.url).resolve(
      ALIAS_PRESET_EXPORT
    );
    const { canonicalBytes, sha256 } = normalizePreset(presetPath);
    expect(canonicalBytes).toBe(10_950);
    expect(sha256).toBe(BASELINE_PRESET_SHA256);
  });

  test("alias preset reports the retained normalized diagnostics", () => {
    const presetPath = createRequire(import.meta.url).resolve(
      ALIAS_PRESET_EXPORT
    );
    expect(runProbe(presetPath)).toEqual(BASELINE_PROBE_DIAGNOSTICS);
  });
});
