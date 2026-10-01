import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const GAP_PLAN_SCRIPT = "tools/scripts/epic-af-conformance-gap-plan.ts";
const GAP_PLAN_SCRIPT_PATH = path.join(REPO_ROOT, GAP_PLAN_SCRIPT);
const BIOME_BIN = path.join(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");

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

    const report = JSON.parse(result.stdout) as { diagnostics?: unknown[] };
    expect(result.status, result.stderr).toBe(0);
    expect(report.diagnostics ?? []).toEqual([]);
  });
});
