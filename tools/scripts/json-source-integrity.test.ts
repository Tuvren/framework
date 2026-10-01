import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { runJsonSourceCheck } from "./json-source-check.js";
import {
  runCommand as runCommandProcess,
  type RunCommandResult,
} from "./lib/command-runner.js";
import {
  discoverJsonInventory,
  isJsoncProfile,
  JSON_SOURCE_INTEGRITY_EXCLUSIONS,
  selectJsonInventory,
  validateJsonSources,
} from "./lib/json-source-integrity.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function withScratch<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "json-integrity-"));
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

  test("keeps jsconfig variants strict while accepting the established jsconfig.json profile", async () => {
    await withScratch(async (directory) => {
      const strictVariant = write(
        directory,
        "jsconfig.foo.json",
        '{/* not an established profile */"a": 1,}\n'
      );
      const established = write(
        directory,
        "jsconfig.json",
        '{/* established profile */"a": 1,}\n'
      );

      expect(isJsoncProfile(strictVariant)).toBe(false);
      expect(isJsoncProfile(established)).toBe(true);
      expect((await validateJsonSources([strictVariant])).issues).toHaveLength(
        1
      );
      expect((await validateJsonSources([established])).issues).toEqual([]);
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
  test("runs without Biome policy artifacts and preserves source exclusions", async () => {
    await withScratch(async (directory) => {
      expect(Object.isFrozen(JSON_SOURCE_INTEGRITY_EXCLUSIONS)).toBe(true);
      expect(JSON_SOURCE_INTEGRITY_EXCLUSIONS).toHaveLength(44);
      write(directory, "good.json", '{"valid":true}\n');
      write(directory, "duplicate.json", '{"key":1,"key":2}\n');
      write(
        directory,
        ".constitution/evidence/pinned.json",
        '{"protected":1,"protected":2}\n'
      );
      write(
        directory,
        "generated/derived.json",
        '{"protected":1,"protected":2}\n'
      );

      expect(existsSync(path.join(directory, "biome.jsonc"))).toBe(false);
      expect(
        existsSync(path.join(directory, "node_modules/ultracite-biome"))
      ).toBe(false);
      expect(
        existsSync(path.join(directory, "tools/scripts/lib/biome-inventory.ts"))
      ).toBe(false);
      expect(
        (await runCommandProcess(["git", "init"], { cwd: directory })).code
      ).toBe(0);
      expect(
        (await runCommandProcess(["git", "add", "--", "."], { cwd: directory }))
          .code
      ).toBe(0);

      const result = await runJsonSourceCheck({
        formatIgnorePatterns: [],
        repoRoot: directory,
        runCommand: runCommandProcess,
        scopes: ["."],
        sourceIgnorePatterns: JSON_SOURCE_INTEGRITY_EXCLUSIONS,
      });

      expect(result.files).toEqual(["duplicate.json", "good.json"]);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.file).toBe(
        path.join(directory, "duplicate.json")
      );
      expect(result.issues[0]?.message).toContain("Duplicate key");
      expect(result.protectedFiles).toEqual([
        ".constitution/evidence/pinned.json",
        "generated/derived.json",
      ]);
      expect(result.protectedReasons).toEqual([
        {
          file: ".constitution/evidence/pinned.json",
          pattern: ".constitution/**",
          reason: "source-integrity-exclusion",
        },
        {
          file: "generated/derived.json",
          pattern: "**/generated",
          reason: "source-integrity-exclusion",
        },
      ]);
    });
  });

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
      formatIgnorePatterns: [],
      repoRoot: "/repo",
      runCommand,
      scopes: ["scope"],
      sourceIgnorePatterns: ["**/generated"],
    });
    expect(inventory).toEqual({
      codeFiles: ["scope/source.ts"],
      formatFiles: ["scope/tracked.json", "scope/untracked.jsonc"],
      jsonFiles: ["scope/tracked.json", "scope/untracked.jsonc"],
      protectedFiles: ["scope/generated/data.json"],
      protectedReasons: [
        {
          file: "scope/generated/data.json",
          pattern: "**/generated",
          reason: "source-integrity-exclusion",
        },
      ],
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
        [".constitution/**", "**/generated"],
        []
      )
    ).toEqual({
      codeFiles: [],
      formatFiles: [".vscode/settings.json", "package.json"],
      jsonFiles: [".vscode/settings.json", "package.json"],
      protectedFiles: [".constitution/state.json", "generated/schema.json"],
      protectedReasons: [
        {
          file: ".constitution/state.json",
          pattern: ".constitution/**",
          reason: "source-integrity-exclusion",
        },
        {
          file: "generated/schema.json",
          pattern: "**/generated",
          reason: "source-integrity-exclusion",
        },
      ],
    });
  });

  test("keeps formatter-ignored project JSON in the source integrity selection", () => {
    expect(
      selectJsonInventory(
        [
          "project/.alchemy/config.json",
          "project/.open-next/config.json",
          "project/.wrangler/config.json",
          "project/.yarn/config.json",
        ],
        ["project"],
        [],
        ["**/.alchemy", "**/.open-next", "**/.wrangler", "**/.yarn"]
      )
    ).toMatchObject({
      formatFiles: [],
      jsonFiles: [
        "project/.alchemy/config.json",
        "project/.open-next/config.json",
        "project/.wrangler/config.json",
        "project/.yarn/config.json",
      ],
      protectedFiles: [],
    });
  });

  test("preserves a literal backslash in a Git-reported POSIX filename", async () => {
    await withScratch(async (directory) => {
      const filename = String.raw`literal\name.json`;
      write(directory, filename, '{"literal":true}\n');
      expect(
        (await runCommandProcess(["git", "init"], { cwd: directory })).code
      ).toBe(0);
      expect(
        (
          await runCommandProcess(["git", "add", "--", filename], {
            cwd: directory,
          })
        ).code
      ).toBe(0);

      const result = await runJsonSourceCheck({
        formatIgnorePatterns: [],
        repoRoot: directory,
        runCommand: runCommandProcess,
        scopes: ["."],
        sourceIgnorePatterns: [],
      });
      expect(result.files).toEqual([filename]);
      expect(result.issues).toEqual([]);
    });
  });

  test("empty requested scopes and empty native selections fail", async () => {
    expect(() => selectJsonInventory([], [], [], [])).toThrow(
      "at least one JSON scope is required"
    );
    await expect(
      runJsonSourceCheck({
        formatIgnorePatterns: [],
        repoRoot: "/repo",
        runCommand: () =>
          Promise.resolve({ code: 0, stderr: "", stdout: "source.ts\0" }),
        scopes: ["scope"],
        sourceIgnorePatterns: [],
      })
    ).rejects.toThrow("no JSON or JSONC files matched");
  });
});
