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

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseRegenerateCommandArgv } from "./regenerate-command-argv.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SPEC_ROOT = path.resolve(REPO_ROOT, "spec");
const MANIFEST_FILE_NAME = "authority-packet.json";

interface AuthorityPacketManifestFixture {
  freshnessChecks?: { artifact: string; regenerateCommand: string }[];
  packetId?: string;
}

const isAuthorityPacketManifestFixture = (
  value: unknown
): value is AuthorityPacketManifestFixture => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if ("packetId" in value && typeof value.packetId !== "string") {
    return false;
  }
  if (!("freshnessChecks" in value) || value.freshnessChecks === undefined) {
    return true;
  }
  return (
    Array.isArray(value.freshnessChecks) &&
    value.freshnessChecks.every(
      (check: unknown) =>
        typeof check === "object" &&
        check !== null &&
        "artifact" in check &&
        typeof check.artifact === "string" &&
        "regenerateCommand" in check &&
        typeof check.regenerateCommand === "string"
    )
  );
};

const findAuthorityPacketManifests = (directory: string): string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  const manifests: string[] = [];

  for (const entry of entries) {
    const entryPath = path.resolve(directory, entry.name);

    if (entry.isDirectory()) {
      manifests.push(...findAuthorityPacketManifests(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name === MANIFEST_FILE_NAME) {
      manifests.push(entryPath);
    }
  }

  return manifests.toSorted();
};

describe("parseRegenerateCommandArgv", () => {
  test("accepts a real multi-token bun/nx command", () => {
    expect(
      parseRegenerateCommandArgv("bun run nx run core-spec:codegen")
    ).toEqual(["bun", "run", "nx", "run", "core-spec:codegen"]);
  });

  test("rejects a command containing &&", () => {
    expect(() =>
      parseRegenerateCommandArgv("bun run codegen && rm -rf /")
    ).toThrow();
  });

  test("rejects a command containing a pipe", () => {
    expect(() =>
      parseRegenerateCommandArgv("bun run codegen | tee out.log")
    ).toThrow();
  });

  test("rejects a command containing a backtick", () => {
    expect(() => parseRegenerateCommandArgv("bun run `whoami`")).toThrow();
  });

  test("rejects a command containing a $() substitution", () => {
    expect(() => parseRegenerateCommandArgv("bun run $(whoami)")).toThrow();
  });

  test("rejects a command containing a semicolon", () => {
    expect(() =>
      parseRegenerateCommandArgv("bun run codegen; rm -rf /")
    ).toThrow();
  });

  test("rejects a command containing a redirect (<)", () => {
    expect(() =>
      parseRegenerateCommandArgv("bun run codegen < secrets.txt")
    ).toThrow();
  });

  test("rejects a command containing a redirect (>)", () => {
    expect(() =>
      parseRegenerateCommandArgv("bun run codegen > out.txt")
    ).toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => parseRegenerateCommandArgv("")).toThrow();
  });

  test("rejects a whitespace-only string", () => {
    expect(() => parseRegenerateCommandArgv("   ")).toThrow();
  });

  test("rejects a metacharacter-free command whose first token is not allowlisted", () => {
    expect(() => parseRegenerateCommandArgv("python script.py")).toThrow();
  });

  test("accepts a command starting with bunx", () => {
    expect(parseRegenerateCommandArgv("bunx tsx script.ts")).toEqual([
      "bunx",
      "tsx",
      "script.ts",
    ]);
  });

  test("accepts a command starting with cargo", () => {
    expect(parseRegenerateCommandArgv("cargo build --release")).toEqual([
      "cargo",
      "build",
      "--release",
    ]);
  });

  test("accepts a command starting with buf", () => {
    expect(parseRegenerateCommandArgv("buf generate")).toEqual([
      "buf",
      "generate",
    ]);
  });

  test("keeps metacharacter rejection ahead of the allowlist failure", () => {
    const command = "python script.py | cat";
    let failure: unknown;

    try {
      parseRegenerateCommandArgv(command);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);

    if (!(failure instanceof Error)) {
      throw new Error("expected the unsafe command to throw");
    }

    expect(failure.constructor).toBe(Error);
    expect(failure.name).toBe("Error");
    expect(failure.message).toBe(
      'regenerateCommand "python script.py | cat" contains a shell metacharacter (one of | & ; ` $ < > ( )); declare a plain space-separated argv command instead'
    );
    expect(Object.hasOwn(failure, "cause")).toBe(false);
  });
});

describe("parseRegenerateCommandArgv against real authority packets", () => {
  test("every declared regenerateCommand in spec/**/authority-packet.json parses", () => {
    const manifestPaths = findAuthorityPacketManifests(SPEC_ROOT);
    expect(manifestPaths.length).toBeGreaterThan(0);

    const commands: string[] = [];

    for (const manifestPath of manifestPaths) {
      const value = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;

      if (!isAuthorityPacketManifestFixture(value)) {
        throw new TypeError(
          `invalid authority packet fixture at ${manifestPath}`
        );
      }

      for (const check of value.freshnessChecks ?? []) {
        commands.push(check.regenerateCommand);
      }
    }

    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      expect(() => parseRegenerateCommandArgv(command)).not.toThrow();
    }
  });
});
