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

import oxfmtConfig from "../../../oxfmt.config.js";
import { readCoverageEntries, resolveCoverage } from "../biome-lint.js";
import type { CoverageEntry, CoverageResolution } from "../biome-lint.js";
import {
  FORMER_ROOT_DELETED_COMMAND,
  FORMER_ROOT_DISCOVERY_COMMAND,
  parseGitFileList,
  removeDeletedFiles,
  selectFormerRootFiles,
} from "./biome-inventory.js";
import { runCommand } from "./command-runner.js";
import {
  JSON_SOURCE_INTEGRITY_EXCLUSIONS,
  selectJsonInventory,
} from "./json-source-integrity.js";
import {
  collectOxlintSelectedFiles,
  discoverNativeLintProjects,
  discoverOxcProjects,
} from "./native-lint-routing.js";
import { loadNxProjectFiles } from "./nx-projects.js";
import type { NxProjectFile } from "./nx-projects.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const COVERAGE_DIR = path.join(REPO_ROOT, "tools/biome-coverage");
const BQ_PROJECTS = new Set(["kernel-contract-protocol", "kernel-runtime"]);
const OXLINT_COMMAND_PREFIX = "bunx --bun oxlint --type-aware";

let inventoryCache: Promise<string[]> | undefined;

const discoverInventory = async (): Promise<string[]> => {
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
};

const switchProjectsToOxc = (
  files: readonly NxProjectFile[],
  names: ReadonlySet<string> = BQ_PROJECTS
): NxProjectFile[] => {
  return files.map((file) => {
    if (!names.has(file.name)) {
      return file;
    }
    // The canonical whole-project switch (ADR-0070): run from the workspace
    // root and point Oxlint at exactly the project directory. A bare `.` here
    // would lint the whole repository and must not count as project scope.
    const root = path.dirname(file.path);
    return {
      ...file,
      project: {
        ...file.project,
        targets: {
          ...file.project.targets,
          lint: {
            executor: "nx:run-commands",
            options: {
              commands: [
                `${OXLINT_COMMAND_PREFIX} ${root}`,
                `bun tools/scripts/json-check.ts ${root}`,
              ],
              cwd: ".",
              parallel: false,
            },
          },
        },
      },
    };
  });
};

const partitionScenario = (
  additionalAdmissions: boolean
): {
  entries: CoverageEntry[];
  projects: NxProjectFile[];
} => {
  let projects = switchProjectsToOxc(loadNxProjectFiles(REPO_ROOT));
  let entries = readCoverageEntries(COVERAGE_DIR).filter(
    (entry) => entry.list !== "bq"
  );
  if (additionalAdmissions) {
    // Clone real metadata and transfer only the newly admitted roots out of
    // retained coverage. Every scenario still resolves the full inventory.
    projects = switchProjectsToOxc(projects, new Set(["kernel-grpc-client"]));
    projects = projects.map((file) => {
      if (file.name !== "kernel-typescript-sqlite-certification") {
        return file;
      }
      return {
        ...file,
        project: {
          ...file.project,
          targets: {
            ...file.project.targets,
            lint: {
              executor: "nx:run-commands",
              options: {
                command: `bun tools/scripts/json-check.ts --json-only ${path.dirname(file.path)}`,
                cwd: ".",
              },
            },
          },
        },
      };
    });
    entries = entries.filter(
      (entry) =>
        entry.path !== "typescript/kernel/grpc-client" &&
        entry.path !== "typescript/kernel/certification-sqlite"
    );
  }
  return { entries, projects };
};

const expectCompletePartition = (
  inventory: readonly string[],
  resolution: CoverageResolution
): void => {
  expect(resolution.missing).toEqual([]);
  expect(resolution.duplicates).toEqual([]);
  const nativeFiles = [
    ...resolution.oxlintFiles,
    ...resolution.jsonValidatedFiles,
  ];
  const partition = new Set(nativeFiles);
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
  expect(owned + nativeFiles.length).toBe(inventory.length);
};

const isBqFile = (file: string): boolean => {
  return (
    file.startsWith("typescript/kernel/protocol/") ||
    file.startsWith("typescript/kernel/runtime/")
  );
};

const actualNativeFiles = async (
  inventory: readonly string[],
  projects: readonly NxProjectFile[]
): Promise<{ jsonValidatedFiles: string[]; oxlintFiles: string[] }> => {
  const nativeProjects = discoverNativeLintProjects(projects);
  const oxlintFiles = await collectOxlintSelectedFiles(
    nativeProjects.oxcProjects,
    { repoRoot: REPO_ROOT, runCommand }
  );
  const jsonValidatedFiles = new Set<string>();
  const jsonProjects = [
    ...nativeProjects.oxcProjects
      .filter((project) => project.jsonCompanion)
      .map((project) => ({
        name: project.name,
        root: project.root,
      })),
    ...nativeProjects.jsonOnlyProjects,
  ];
  for (const project of jsonProjects) {
    const selection = selectJsonInventory(
      inventory,
      [project.root],
      JSON_SOURCE_INTEGRITY_EXCLUSIONS,
      oxfmtConfig.ignorePatterns ?? []
    );
    for (const file of selection.jsonFiles) {
      jsonValidatedFiles.add(file);
    }
  }
  return {
    jsonValidatedFiles: [...jsonValidatedFiles].sort((left, right) =>
      left.localeCompare(right)
    ),
    // Compare coverage membership independently of project-name ordering.
    oxlintFiles: oxlintFiles.sort((left, right) => left.localeCompare(right)),
  };
};

describe("biome coverage partition", () => {
  test("the real inventory partitions completely between owned and OXC-excluded", async () => {
    const inventory = await discoverInventory();
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory).toContain("biome.jsonc");
    expect(inventory).toContain("tools/biome-coverage/bq.json");

    const nativeFiles = await actualNativeFiles(
      inventory,
      loadNxProjectFiles(REPO_ROOT)
    );
    const resolution = resolveCoverage(
      inventory,
      readCoverageEntries(COVERAGE_DIR),
      nativeFiles
    );

    expect(resolution.oxlintFiles).toEqual(nativeFiles.oxlintFiles);
    expect(resolution.jsonValidatedFiles).toEqual(
      nativeFiles.jsonValidatedFiles
    );
    expectCompletePartition(inventory, resolution);
  });

  test.each([false, true])(
    "a BQ-style switch stays complete through the real metadata path (additional admissions: %p)",
    async (additionalAdmissions) => {
      const inventory = await discoverInventory();
      const { entries: withoutBq, projects } =
        partitionScenario(additionalAdmissions);
      const switched = discoverOxcProjects(projects);
      expect(
        switched
          .filter((project) => BQ_PROJECTS.has(project.name))
          .map((project) => project.root)
      ).toEqual(["typescript/kernel/protocol", "typescript/kernel/runtime"]);

      const nativeFiles = await actualNativeFiles(inventory, projects);
      const resolution = resolveCoverage(inventory, withoutBq, nativeFiles);

      expect(resolution.oxlintFiles).toEqual(nativeFiles.oxlintFiles);
      expect(resolution.jsonValidatedFiles).toEqual(
        nativeFiles.jsonValidatedFiles
      );
      expectCompletePartition(inventory, resolution);
      expect(resolution.oxlintFiles.filter(isBqFile)).toHaveLength(42);
      expect(resolution.jsonValidatedFiles.filter(isBqFile)).toHaveLength(14);
      expect(resolution.perList.get("bq")).toEqual([]);
      if (additionalAdmissions) {
        expect(discoverNativeLintProjects(projects).oxcProjects).toContainEqual(
          {
            jsonCompanion: true,
            name: "kernel-grpc-client",
            root: "typescript/kernel/grpc-client",
          }
        );
        expect(
          discoverNativeLintProjects(projects).jsonOnlyProjects
        ).toContainEqual({
          name: "kernel-typescript-sqlite-certification",
          root: "typescript/kernel/certification-sqlite",
        });
        expect(resolution.oxlintFiles).toContain(
          "typescript/kernel/grpc-client/src/index.ts"
        );
        expect(resolution.jsonValidatedFiles).toContain(
          "typescript/kernel/grpc-client/project.json"
        );
        expect(resolution.jsonValidatedFiles).toContain(
          "typescript/kernel/certification-sqlite/project.json"
        );
        expect(
          resolution.oxlintFiles.some((file) =>
            file.startsWith("typescript/kernel/certification-sqlite/")
          )
        ).toBe(false);
      }
    }
  );

  test.each([false, true])(
    "standalone Oxlint never receives credit for a project's JSON (additional admissions: %p)",
    async (additionalAdmissions) => {
      const inventory = await discoverInventory();
      const { entries, projects } = partitionScenario(additionalAdmissions);
      const switchedFiles = projects.map((file) => {
        if (!BQ_PROJECTS.has(file.name)) {
          return file;
        }
        const root = path.dirname(file.path);
        return {
          ...file,
          project: {
            ...file.project,
            targets: {
              ...file.project.targets,
              lint: {
                executor: "nx:run-commands",
                options: {
                  command: `${OXLINT_COMMAND_PREFIX} ${root}`,
                  cwd: ".",
                },
              },
            },
          },
        };
      });
      const nativeFiles = await actualNativeFiles(inventory, switchedFiles);
      const resolution = resolveCoverage(inventory, entries, nativeFiles);

      expect(resolution.oxlintFiles.filter(isBqFile)).toHaveLength(42);
      expect(resolution.jsonValidatedFiles.filter(isBqFile)).toEqual([]);
      expect(resolution.duplicates).toEqual([]);
      expect(resolution.missing).toHaveLength(14);
      expect(resolution.missing).toEqual(
        inventory.filter((file) => isBqFile(file) && file.endsWith(".json"))
      );
      if (additionalAdmissions) {
        expect(resolution.oxlintFiles).toContain(
          "typescript/kernel/grpc-client/src/index.ts"
        );
        expect(resolution.jsonValidatedFiles).toContain(
          "typescript/kernel/grpc-client/project.json"
        );
        expect(resolution.jsonValidatedFiles).toContain(
          "typescript/kernel/certification-sqlite/project.json"
        );
      }
    }
  );

  test.each([false, true])(
    "gaps, duplicates, and wrong JSON companions still fail (additional admissions: %p)",
    async (additionalAdmissions) => {
      const inventory = await discoverInventory();
      const { entries, projects } = partitionScenario(additionalAdmissions);
      const nativeFiles = await actualNativeFiles(inventory, projects);
      const codeFile = "typescript/kernel/protocol/src/index.ts";
      expect(nativeFiles.oxlintFiles).toContain(codeFile);

      const gap = resolveCoverage(inventory, entries, {
        ...nativeFiles,
        oxlintFiles: nativeFiles.oxlintFiles.filter(
          (file) => file !== codeFile
        ),
      });
      expect(gap.missing).toEqual([codeFile]);
      expect(gap.duplicates).toEqual([]);

      const duplicate = resolveCoverage(
        inventory,
        [...entries, { list: "bq", path: "typescript/kernel/protocol" }],
        nativeFiles
      );
      expect(duplicate.missing).toEqual([]);
      expect(duplicate.duplicates).toContainEqual({
        lists: ["oxlint", "bq"],
        path: codeFile,
      });
      expect(duplicate.duplicates).toContainEqual({
        lists: ["json-source-check", "bq"],
        path: "typescript/kernel/protocol/project.json",
      });

      const wrongJsonProjects = projects.map((file) => {
        if (file.name !== "kernel-contract-protocol") {
          return file;
        }
        return {
          ...file,
          project: {
            ...file.project,
            targets: {
              ...file.project.targets,
              lint: {
                executor: "nx:run-commands",
                options: {
                  commands: [
                    `${OXLINT_COMMAND_PREFIX} typescript/kernel/protocol`,
                    "bun tools/scripts/json-check.ts typescript/kernel/runtime",
                  ],
                  cwd: ".",
                  parallel: false,
                },
              },
            },
          },
        };
      });
      const wrongJsonFiles = await actualNativeFiles(
        inventory,
        wrongJsonProjects
      );
      const wrongJson = resolveCoverage(inventory, entries, wrongJsonFiles);
      const protocolInventory = inventory.filter((file) =>
        file.startsWith("typescript/kernel/protocol/")
      );
      expect(protocolInventory.length).toBeGreaterThan(0);
      expect(wrongJson.missing).toEqual(protocolInventory);
      expect(wrongJson.duplicates).toEqual([]);
      expect(
        wrongJson.jsonValidatedFiles.filter((file) =>
          file.startsWith("typescript/kernel/protocol/")
        )
      ).toEqual([]);
    }
  );
});
