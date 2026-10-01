import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { runJsonSourceCheck } from "./json-source-check.js";
import type { RunCommandResult } from "./lib/command-runner.js";
import {
  discoverJsonInventory,
  isJsoncProfile,
  selectJsonInventory,
  validateJsonSources,
} from "./lib/json-source-integrity.js";

const TEST_TMP_ROOT = "/home/oscar/.cache/tuvren-bp-followups/tmp";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function withScratch<T>(run: (directory: string) => Promise<T>): Promise<T> {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const directory = mkdtempSync(path.join(TEST_TMP_ROOT, "json-integrity-"));
  return run(directory).finally(() => {
    rmSync(directory, { force: true, recursive: true });
  });
}

function write(directory: string, relative: string, source: string): string {
  const file = path.join(directory, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

describe("native JSON source integrity", () => {
  test("rejects malformed and comment-bearing strict JSON", async () => {
    await withScratch(async (directory) => {
      const malformed = write(directory, "malformed.json", '{"a":}\n');
      const commented = write(
        directory,
        "commented.json",
        '{\n  // formatted, but not strict JSON\n  "a": 1\n}\n'
      );
      const result = await validateJsonSources([malformed, commented]);
      expect(result.issues.map((issue) => issue.file).sort()).toEqual(
        [commented, malformed].sort()
      );
    });
  });

  test("accepts comments and trailing commas only in established JSONC profiles", async () => {
    await withScratch(async (directory) => {
      const files = [
        write(directory, "settings.jsonc", '{/* ok */"a": 1,}\n'),
        write(directory, "tsconfig.typecheck.json", '{/* ok */"a": 1,}\n'),
        write(directory, "jsconfig.json", '{/* ok */"a": 1,}\n'),
        write(directory, ".vscode/settings.json", '{/* ok */"a": 1,}\n'),
      ];
      expect(files.every((file) => isJsoncProfile(file))).toBe(true);
      expect((await validateJsonSources(files)).issues).toEqual([]);
    });
  });

  test("rejects duplicate, escaped-equivalent, nested and __proto__ keys", async () => {
    await withScratch(async (directory) => {
      const files = [
        write(directory, "duplicate.json", '{"a":1,"a":2}\n'),
        write(directory, "escaped.json", '{"a":1,"\\u0061":2}\n'),
        write(directory, "nested.json", '{"x":{"a":1,"a":2}}\n'),
        write(directory, "prototype.json", '{"__proto__":1,"__proto__":2}\n'),
      ];
      const result = await validateJsonSources(files);
      expect(result.issues).toHaveLength(4);
      expect(
        result.issues.every((issue) => issue.message.includes("Duplicate key"))
      ).toBe(true);
    });
  });

  test("allows equal property names in separate objects", async () => {
    await withScratch(async (directory) => {
      const file = write(
        directory,
        "separate.json",
        '{"left":{"a":1},"right":{"a":2}}\n'
      );
      expect((await validateJsonSources([file])).issues).toEqual([]);
    });
  });

  test("validation is read-only and creates no build artifacts", async () => {
    await withScratch(async (directory) => {
      const file = write(directory, "source.json", '{"a":1}\n');
      const before = readFileSync(file, "utf8");
      const entriesBefore = readdirSync(directory);
      expect((await validateJsonSources([file])).issues).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(readdirSync(directory)).toEqual(entriesBefore);
    });
  });

  test("source integrity does not replace authority schema validation", async () => {
    await withScratch(async (directory) => {
      const file = write(directory, "authority-packet.json", "{}\n");
      expect((await validateJsonSources([file])).issues).toEqual([]);

      const schema = JSON.parse(
        readFileSync(
          path.join(REPO_ROOT, "tools/schemas/authority-packet.schema.json"),
          "utf8"
        )
      ) as AnySchema;
      const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
        schema
      );
      expect(validate({})).toBe(false);
    });
  });
});

describe("JSON inventory", () => {
  test("includes untracked files, subtracts deletions and accounts for protected files", async () => {
    const commands: string[][] = [];
    const runCommand = (
      command: readonly string[]
    ): Promise<RunCommandResult> => {
      commands.push([...command]);
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: command.includes("--deleted")
          ? "scope/deleted.json\0"
          : [
              "scope/tracked.json",
              "scope/untracked.jsonc",
              "scope/deleted.json",
              "scope/generated/data.json",
              "scope/source.ts",
            ]
              .map((file) => `${file}\0`)
              .join(""),
      });
    };
    const inventory = await discoverJsonInventory({
      ignorePatterns: ["**/generated"],
      repoRoot: "/repo",
      runCommand,
      scopes: ["scope"],
    });
    expect(inventory).toEqual({
      codeFiles: ["scope/source.ts"],
      jsonFiles: ["scope/tracked.json", "scope/untracked.jsonc"],
      protectedFiles: ["scope/generated/data.json"],
    });
    expect(commands).toHaveLength(2);
  });

  test("preserves hidden JSON profiles and constitution/generated exclusions", () => {
    expect(
      selectJsonInventory(
        [
          ".constitution/state.json",
          ".vscode/settings.json",
          "generated/schema.json",
          "package.json",
        ],
        ["."],
        [".constitution/**", "**/generated"]
      )
    ).toEqual({
      codeFiles: [],
      jsonFiles: [".vscode/settings.json", "package.json"],
      protectedFiles: [".constitution/state.json", "generated/schema.json"],
    });
  });

  test("empty requested scopes and empty native selections fail", async () => {
    expect(() => selectJsonInventory([], [], [])).toThrow(
      "at least one JSON scope is required"
    );
    await expect(
      runJsonSourceCheck({
        ignorePatterns: [],
        repoRoot: "/repo",
        runCommand: () =>
          Promise.resolve({ code: 0, stderr: "", stdout: "source.ts\0" }),
        scopes: ["scope"],
      })
    ).rejects.toThrow("no JSON or JSONC files matched");
  });
});
