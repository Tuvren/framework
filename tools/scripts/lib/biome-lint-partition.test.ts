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

// KRT-BP008 / ADR-0070. Companion to biome-lint.test.ts: the coverage tests
// there are kept to the routing seam, while the complete disjoint partition
// and the BQ-style OXC switch run here against the real inventory and the real
// Nx project metadata so a switch cannot reappear as a partition gap.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  discoverOxcProjects,
  readCoverageEntries,
  resolveCoverage,
  type CoverageResolution,
} from "../biome-lint.js";
import {
  FORMER_ROOT_DELETED_COMMAND,
  FORMER_ROOT_DISCOVERY_COMMAND,
  parseGitFileList,
  removeDeletedFiles,
  selectFormerRootFiles,
} from "./biome-inventory.js";
import { runCommand } from "./command-runner.js";
import { loadNxProjectFiles, type NxProjectFile } from "./nx-projects.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const COVERAGE_DIR = path.join(REPO_ROOT, "tools/biome-coverage");
const BQ_PROJECTS = new Set(["kernel-contract-protocol", "kernel-runtime"]);
const OXLINT_COMMAND = "bunx --bun oxlint --type-aware .";

let inventoryCache: Promise<string[]> | undefined;

async function discoverInventory(): Promise<string[]> {
  inventoryCache ??= (async () => {
    const discovery = await runCommand(FORMER_ROOT_DISCOVERY_COMMAND, {
      captureOutput: true,
      cwd: REPO_ROOT,
    });
    expect(discovery.code).toBe(0);
    const deletion = await runCommand(FORMER_ROOT_DELETED_COMMAND, {
      captureOutput: true,
      cwd: REPO_ROOT,
    });
    expect(deletion.code).toBe(0);
    return selectFormerRootFiles(
      REPO_ROOT,
      removeDeletedFiles(
        parseGitFileList(discovery.stdout),
        parseGitFileList(deletion.stdout)
      )
    );
  })();
  return await inventoryCache;
}

function switchBqProjectsToOxc(
  files: readonly NxProjectFile[]
): NxProjectFile[] {
  return files.map((file) => {
    if (!BQ_PROJECTS.has(file.name)) {
      return file;
    }
    return {
      ...file,
      project: {
        ...file.project,
        targets: {
          ...file.project.targets,
          lint: { options: { command: OXLINT_COMMAND } },
        },
      },
    };
  });
}

function expectCompletePartition(
  inventory: readonly string[],
  resolution: CoverageResolution
): void {
  expect(resolution.missing).toEqual([]);
  expect(resolution.duplicates).toEqual([]);
  const partition = new Set(resolution.oxcExcluded);
  let owned = 0;
  for (const files of resolution.perList.values()) {
    owned += files.length;
    for (const file of files) {
      partition.add(file);
    }
  }
  // Owned and OXC-excluded together are exactly the inventory, with no
  // overlap and no leftover file: the complete disjoint partition.
  expect(partition.size).toBe(inventory.length);
  expect(owned + resolution.oxcExcluded.length).toBe(inventory.length);
}

describe("biome coverage partition", () => {
  test("the real inventory partitions completely between owned and OXC-excluded", async () => {
    const inventory = await discoverInventory();
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory).toContain("biome.jsonc");
    expect(inventory).toContain("tools/biome-coverage/bq.json");

    const resolution = resolveCoverage(
      inventory,
      readCoverageEntries(COVERAGE_DIR),
      discoverOxcProjects(loadNxProjectFiles(REPO_ROOT)).map(
        (project) => project.root
      )
    );

    expect(resolution.oxcExcluded).toEqual([]);
    expectCompletePartition(inventory, resolution);
  });

  test("a BQ-style switch stays complete through the real metadata path", async () => {
    const inventory = await discoverInventory();
    const switched = discoverOxcProjects(
      switchBqProjectsToOxc(loadNxProjectFiles(REPO_ROOT))
    );
    expect(switched.map((project) => project.root)).toEqual([
      "typescript/kernel/protocol",
      "typescript/kernel/runtime",
    ]);

    const withoutBq = readCoverageEntries(COVERAGE_DIR).filter(
      (entry) => entry.list !== "bq"
    );
    const resolution = resolveCoverage(
      inventory,
      withoutBq,
      switched.map((project) => project.root)
    );

    expectCompletePartition(inventory, resolution);
    expect(resolution.oxcExcluded.length).toBeGreaterThan(0);
    expect(resolution.perList.get("bq")).toEqual([]);
    for (const file of resolution.oxcExcluded) {
      expect(
        file.startsWith("typescript/kernel/protocol/") ||
          file.startsWith("typescript/kernel/runtime/")
      ).toBe(true);
    }
  });
});
