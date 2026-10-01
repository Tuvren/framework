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
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import oxfmtConfig from "../../oxfmt.config.js";
import {
  readSnapshot,
  type SnapshotLedgerEntry,
  writeApiSnapshot,
} from "./api-freeze-gate.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REPOSITORY_SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "tools/scripts/__snapshots__/api-surface/api-surface-snapshot.json"
);
const CACHE_IGNORE_PATTERN = "**/.cache";
const EXPECTED_LEDGER_ENTRY: SnapshotLedgerEntry = {
  bump: "minor",
  changes: ["@tuvren/core/testing#WriterProbe: export-added"],
  recordedAt: "2026-10-01T00:00:00.000Z",
};

async function createScratchFormatterConfig(
  directory: string
): Promise<string> {
  const configPath = path.join(directory, ".oxfmtrc.json");
  const config = {
    ...oxfmtConfig,
    // Ultracite excludes every **/.cache path. The test's required scratch
    // root lives there, so only remove that discovery rule; every formatter
    // policy option and all other repository ignores remain unchanged.
    ignorePatterns: (oxfmtConfig.ignorePatterns ?? []).filter(
      (pattern) => pattern !== CACHE_IGNORE_PATTERN
    ),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function requireSnapshot<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected the API snapshot to exist");
  }

  return value;
}

describe("API freeze snapshot writer", () => {
  test("appends through the production writer while preserving the complete snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "api-freeze-writer-"));

    try {
      const repositoryBytesBefore = await readFile(REPOSITORY_SNAPSHOT_PATH);
      const original = requireSnapshot(
        await readSnapshot(REPOSITORY_SNAPSHOT_PATH)
      );
      const scratchSnapshotPath = path.join(
        directory,
        "api-surface-snapshot.json"
      );
      const formatterConfigPath = await createScratchFormatterConfig(directory);
      await writeFile(scratchSnapshotPath, repositoryBytesBefore);

      await writeApiSnapshot({
        formatterConfigPath,
        ledgerEntry: EXPECTED_LEDGER_ENTRY,
        live: original.entrypoints,
        repoRoot: REPO_ROOT,
        snapshotPath: scratchSnapshotPath,
      });

      const written = requireSnapshot(await readSnapshot(scratchSnapshotPath));
      expect(Object.keys(written).sort()).toEqual(Object.keys(original).sort());
      expect(written.$description).toBe(original.$description);
      expect(written.authority).toEqual(original.authority);
      expect(written.entrypoints).toEqual(original.entrypoints);
      expect(written.ledger.slice(0, original.ledger.length)).toEqual(
        original.ledger
      );
      expect(written.ledger).toHaveLength(original.ledger.length + 1);
      expect(written.ledger.at(-1)).toEqual(EXPECTED_LEDGER_ENTRY);

      const formattedBytes = await readFile(scratchSnapshotPath);
      const check = spawnSync(
        "bunx",
        [
          "--bun",
          "oxfmt",
          "-c",
          formatterConfigPath,
          "--check",
          scratchSnapshotPath,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
      expect(await readFile(scratchSnapshotPath)).toEqual(formattedBytes);
      expect(await readFile(REPOSITORY_SNAPSHOT_PATH)).toEqual(
        repositoryBytesBefore
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects a formatter that changes a parsed snapshot value", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "api-freeze-writer-mutation-")
    );

    try {
      const repositoryBytes = await readFile(REPOSITORY_SNAPSHOT_PATH);
      const original = requireSnapshot(
        await readSnapshot(REPOSITORY_SNAPSHOT_PATH)
      );
      const scratchSnapshotPath = path.join(
        directory,
        "api-surface-snapshot.json"
      );
      await writeFile(scratchSnapshotPath, repositoryBytes);

      await expect(
        writeApiSnapshot({
          formatter: ({ snapshotPath }) => {
            const before = readFileSync(snapshotPath, "utf8");
            const after = before.replace(
              EXPECTED_LEDGER_ENTRY.recordedAt,
              "2099-01-01T00:00:00.000Z"
            );

            if (after === before) {
              return {
                status: 1,
                stderr: "mutation control did not find its ledger marker",
              };
            }

            writeFileSync(snapshotPath, after);
            return { status: 0, stderr: "" };
          },
          ledgerEntry: EXPECTED_LEDGER_ENTRY,
          live: original.entrypoints,
          repoRoot: REPO_ROOT,
          snapshotPath: scratchSnapshotPath,
        })
      ).rejects.toThrow(
        "formatter pass altered the parsed API snapshot values"
      );
      expect(await readFile(REPOSITORY_SNAPSHOT_PATH)).toEqual(repositoryBytes);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
