/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// KRT-BP008 / ADR-0070. The retained Biome gate derives its former-root
// inventory from the working tree and owned configuration, never from a
// whole-root `biome lint .`. These tests hold that derivation to the measured
// Biome output as a one-time control and exercise the ignore/extension
// boundaries the gate must respect.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  FORMER_ROOT_DELETED_COMMAND,
  FORMER_ROOT_DISCOVERY_COMMAND,
  parseGitFileList,
  readBiomeIncludes,
  removeDeletedFiles,
  selectFormerRootFiles,
} from "./biome-inventory.js";
import { runCommand } from "./command-runner.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BIOME_BIN = path.join(REPO_ROOT, "node_modules/@biomejs/biome/bin/biome");

const PROCESSED_FILE_LINE_PATTERN = /^\s*-\s+(.+?)\s*$/;
const BIOME_CONTROL_COMMAND = [
  process.execPath,
  BIOME_BIN,
  "lint",
  ".",
  "--verbose",
  "--max-diagnostics=0",
  "--colors=off",
] as const;

function parseProcessedFiles(verboseOutput: string): string[] {
  const files: string[] = [];
  let collecting = false;
  for (const line of verboseOutput.split("\n")) {
    if (line.includes("Files processed:")) {
      collecting = true;
      continue;
    }
    if (line.includes("Files fixed:")) {
      collecting = false;
      continue;
    }
    if (!collecting) {
      continue;
    }
    const match = PROCESSED_FILE_LINE_PATTERN.exec(line);
    if (match?.[1] !== undefined) {
      files.push(match[1]);
    }
  }
  return files;
}

async function readGitCandidates(): Promise<string[]> {
  const discovery = await runCommand(FORMER_ROOT_DISCOVERY_COMMAND, {
    captureOutput: true,
    cwd: REPO_ROOT,
  });
  expect(discovery.code).toBe(0);
  return parseGitFileList(discovery.stdout);
}

async function readFilesystemInventory(): Promise<string[]> {
  return selectFormerRootFiles(REPO_ROOT, await readWorkingTreeCandidates());
}

async function readWorkingTreeCandidates(): Promise<string[]> {
  const candidates = await readGitCandidates();
  const deletion = await runCommand(FORMER_ROOT_DELETED_COMMAND, {
    captureOutput: true,
    cwd: REPO_ROOT,
  });
  expect(deletion.code).toBe(0);
  return removeDeletedFiles(candidates, parseGitFileList(deletion.stdout));
}

async function writeGitFixture(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "biome-inventory-git-"));
  writeFileSync(
    path.join(root, "biome.jsonc"),
    '{ "files": { "includes": ["**"] } }\n'
  );
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/kept.ts"), "export const kept = 1;\n");
  writeFileSync(path.join(root, "src/kept.json"), '{ "kept": true }\n');
  writeFileSync(
    path.join(root, "src/deleted.ts"),
    "export const deleted = 1;\n"
  );
  const git = (args: string[]): Promise<unknown> =>
    runCommand(["git", ...args], { captureOutput: true, cwd: root });
  await git(["init", "-q", "-b", "main"]);
  await git(["add", "-A"]);
  await git([
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "user.name=fixture",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  rmSync(path.join(root, "src/deleted.ts"));
  writeFileSync(
    path.join(root, "src/untracked.ts"),
    "export const untracked = 1;\n"
  );
  return root;
}

describe("former-root inventory derivation", () => {
  test("parseGitFileList splits NUL-delimited git output and drops empties", () => {
    expect(parseGitFileList("a.ts\0tools/b.json\0")).toEqual([
      "a.ts",
      "tools/b.json",
    ]);
    expect(parseGitFileList("")).toEqual([]);
  });

  test("parseProcessedFiles reads only the Biome processed list", () => {
    const output = [
      " VERBOSE ━━━",
      "",
      "  i Files processed:",
      "",
      "  - biome.jsonc",
      "  - tools/scripts/biome-lint.ts",
      "",
      " VERBOSE ━━━",
      "",
      "  i Files fixed:",
      "",
      "  ! The list is empty.",
      "",
    ].join("\n");
    expect(parseProcessedFiles(output)).toEqual([
      "biome.jsonc",
      "tools/scripts/biome-lint.ts",
    ]);
  });

  test("git enumeration respects ignore sources and keeps untracked files", async () => {
    const candidates = await readGitCandidates();
    expect(candidates).toContain("biome.jsonc");
    expect(candidates).toContain("package.json");
    for (const ignoredRoot of [
      ".cache/",
      ".nx/cache/",
      "node_modules/",
      "target/",
    ]) {
      expect(
        candidates.some((file) => file.startsWith(ignoredRoot)),
        ignoredRoot
      ).toBe(false);
    }
  });

  test("owned includes resolve positive and negative patterns through extends", () => {
    const includes = readBiomeIncludes(path.join(REPO_ROOT, "biome.jsonc"));
    expect(includes).toContain("**");
    expect(includes).toContain("!!**/generated");
    expect(includes).toContain("!!target");
    expect(includes).toContain("!.claude");
  });

  test("selection keeps supported files and rejects generated, ignored and unknown types", () => {
    const candidates = [
      "tools/new-file.ts",
      "tools/new-file.tsx",
      "tools/new-file.mjs",
      "tools/new-file.json",
      "tools/new-file.jsonc",
      "new-untracked.ts",
      "tools/new-file.css",
      "tools/new-file.txt",
      "target/ignored.ts",
      ".claude/ignored.ts",
      ".dart_tool/ignored.ts",
      ".cache/ignored.ts",
      "pkg/dist/ignored.ts",
      "pkg/build/ignored.ts",
      "pkg/coverage/ignored.ts",
      "pkg/_generated/ignored.ts",
      "pkg/x.gen.ts",
      "typescript/telemetry/semconv/src/lib/generated/ignored.ts",
      "typescript/kernel/grpc-client/tsconfig.kernel-interop.generated.json",
    ];
    expect(selectFormerRootFiles(REPO_ROOT, candidates)).toEqual([
      "new-untracked.ts",
      "tools/new-file.json",
      "tools/new-file.jsonc",
      "tools/new-file.mjs",
      "tools/new-file.ts",
      "tools/new-file.tsx",
    ]);
  });

  test("a confirmed working-tree deletion is omitted while existing and untracked files remain", async () => {
    const root = await writeGitFixture();
    try {
      const discovery = await runCommand(FORMER_ROOT_DISCOVERY_COMMAND, {
        captureOutput: true,
        cwd: root,
      });
      expect(discovery.code).toBe(0);
      const candidates = parseGitFileList(discovery.stdout);
      // Git still lists the tracked path it no longer finds on disk.
      expect(candidates).toContain("src/deleted.ts");

      const deletion = await runCommand(FORMER_ROOT_DELETED_COMMAND, {
        captureOutput: true,
        cwd: root,
      });
      expect(deletion.code).toBe(0);
      expect(parseGitFileList(deletion.stdout)).toEqual(["src/deleted.ts"]);

      const selected = selectFormerRootFiles(
        root,
        removeDeletedFiles(
          candidates,
          parseGitFileList(deletion.stdout)
        )
      );
      expect(selected).toContain("src/kept.ts");
      expect(selected).toContain("src/kept.json");
      expect(selected).toContain("src/untracked.ts");
      expect(selected).not.toContain("src/deleted.ts");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("filesystem discovery matches the Biome whole-root control exactly", async () => {
    const control = await runCommand(BIOME_CONTROL_COMMAND, {
      captureOutput: true,
      cwd: REPO_ROOT,
    });
    const controlFiles = parseProcessedFiles(control.stdout);
    expect(controlFiles.length).toBeGreaterThan(0);

    const filesystem = await readFilesystemInventory();
    expect(filesystem).toEqual(
      [...controlFiles].sort((left, right) => left.localeCompare(right))
    );
  });
});
