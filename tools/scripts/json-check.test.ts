import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseJsonCheckArguments, runJsonCheck } from "./json-check.js";
import type { RunCommandResult } from "./lib/command-runner.js";
import { JSON_SOURCE_INTEGRITY_EXCLUSIONS } from "./lib/json-source-integrity.js";

function withScratch<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "json-check-"));
  return run(directory).finally(() => {
    rmSync(directory, { force: true, recursive: true });
  });
}

function write(directory: string, relative: string, source: string): void {
  const file = path.join(directory, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
}

function discoveryAndFormatRunner(
  candidates: readonly string[],
  formatCode: number,
  commands: string[][]
): (command: readonly string[]) => Promise<RunCommandResult> {
  return (command): Promise<RunCommandResult> => {
    commands.push([...command]);
    if (command[0] === "git") {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: command.includes("--deleted")
          ? ""
          : candidates.map((file) => `${file}\0`).join(""),
      });
    }
    return Promise.resolve({ code: formatCode, stderr: "", stdout: "" });
  };
}

describe("native JSON format gate", () => {
  test("a mixed project validates JSON and passes exact files to Oxfmt", async () => {
    await withScratch(async (directory) => {
      write(directory, "project/data.json", '{"a":1}\n');
      write(directory, "project/source.ts", "export {};\n");
      const commands: string[][] = [];
      const result = await runJsonCheck({
        formatIgnorePatterns: [],
        jsonOnly: false,
        repoRoot: directory,
        runCommand: discoveryAndFormatRunner(
          ["project/data.json", "project/source.ts"],
          0,
          commands
        ),
        scopes: ["project"],
        sourceIgnorePatterns: JSON_SOURCE_INTEGRITY_EXCLUSIONS,
      });
      expect(result.codeFiles).toEqual(["project/source.ts"]);
      expect(result.jsonFiles).toEqual(["project/data.json"]);
      expect(result.issues).toEqual([]);
      expect(result.formatRun).toEqual({
        code: 0,
        files: ["project/data.json"],
      });
      expect(commands.at(-1)?.slice(-2)).toEqual([
        "--check",
        "project/data.json",
      ]);
    });
  });

  test("a JSON-only project fails when a new JS or TS file appears", async () => {
    await withScratch(async (directory) => {
      write(directory, "spec/data.json", '{"a":1}\n');
      write(directory, "spec/generated/new.ts", "export {};\n");
      await expect(
        runJsonCheck({
          formatIgnorePatterns: ["**/generated"],
          jsonOnly: true,
          repoRoot: directory,
          runCommand: discoveryAndFormatRunner(
            ["spec/data.json", "spec/generated/new.ts"],
            0,
            []
          ),
          scopes: ["spec"],
          sourceIgnorePatterns: ["**/generated"],
        })
      ).rejects.toThrow("JSON-only scope contains code: spec/generated/new.ts");
    });
  });

  test("source-checks formatter-ignored JSON without invoking an unmatched Oxfmt command", async () => {
    await withScratch(async (directory) => {
      write(directory, "project/.yarn/config.json", '{"a":1,"a":2}\n');
      const invalidCommands: string[][] = [];
      const invalid = await runJsonCheck({
        formatIgnorePatterns: ["**/.yarn"],
        jsonOnly: true,
        repoRoot: directory,
        runCommand: discoveryAndFormatRunner(
          ["project/.yarn/config.json"],
          0,
          invalidCommands
        ),
        scopes: ["project"],
        sourceIgnorePatterns: JSON_SOURCE_INTEGRITY_EXCLUSIONS,
      });
      expect(invalid.jsonFiles).toEqual(["project/.yarn/config.json"]);
      expect(invalid.formatFiles).toEqual([]);
      expect(invalid.issues).toHaveLength(1);
      expect(invalid.formatRun).toBeUndefined();
      expect(invalidCommands).toHaveLength(2);

      write(directory, "project/.yarn/config.json", '{"a":1}\n');
      const validCommands: string[][] = [];
      const valid = await runJsonCheck({
        formatIgnorePatterns: ["**/.yarn"],
        jsonOnly: true,
        repoRoot: directory,
        runCommand: discoveryAndFormatRunner(
          ["project/.yarn/config.json"],
          0,
          validCommands
        ),
        scopes: ["project"],
        sourceIgnorePatterns: JSON_SOURCE_INTEGRITY_EXCLUSIONS,
      });
      expect(valid.issues).toEqual([]);
      expect(valid.formatRun).toBeUndefined();
      expect(validCommands).toHaveLength(2);
    });
  });

  test("source failures prevent formatting and formatter failures propagate", async () => {
    await withScratch(async (directory) => {
      write(directory, "bad/data.json", '{"a":1,"a":2}\n');
      const invalidCommands: string[][] = [];
      const invalid = await runJsonCheck({
        formatIgnorePatterns: [],
        jsonOnly: false,
        repoRoot: directory,
        runCommand: discoveryAndFormatRunner(
          ["bad/data.json"],
          0,
          invalidCommands
        ),
        scopes: ["bad"],
        sourceIgnorePatterns: [],
      });
      expect(invalid.issues).toHaveLength(1);
      expect(invalid.formatRun).toBeUndefined();
      expect(invalidCommands).toHaveLength(2);

      write(directory, "bad/data.json", '{"a":1}\n');
      const formatCommands: string[][] = [];
      const unformatted = await runJsonCheck({
        formatIgnorePatterns: [],
        jsonOnly: false,
        repoRoot: directory,
        runCommand: discoveryAndFormatRunner(
          ["bad/data.json"],
          1,
          formatCommands
        ),
        scopes: ["bad"],
        sourceIgnorePatterns: [],
      });
      expect(unformatted.issues).toEqual([]);
      expect(unformatted.formatRun?.code).toBe(1);
    });
  });

  test("rejects unknown flags instead of accepting a no-op option", () => {
    expect(() => parseJsonCheckArguments(["--ignore", "spec"])).toThrow(
      "unknown option: --ignore"
    );
    expect(parseJsonCheckArguments(["--json-only", "spec"])).toEqual({
      jsonOnly: true,
      scopes: ["spec"],
    });
  });
});
