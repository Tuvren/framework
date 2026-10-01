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

// KRT-BP008 / ADR-0070. The discovery contract must credit a whole project
// root only to the invocation `nx run <project>:lint` actually executes and
// only when that invocation covers the complete project directory. A partial
// path, an extra ignore/scope flag, a wrong working directory, an unselected
// optional configuration, an option nx:run-commands would forward onto the
// command (`args`, `__unparsed__`, an unrecognized scalar option) or a custom
// executor must leave the project in the retained Biome gate.

import { describe, expect, test } from "bun:test";

import {
  discoverNativeLintProjects,
  discoverOxcProjects,
} from "./native-lint-routing.js";
import type { NxProjectFile, NxProjectTarget } from "./nx-projects.js";

const PROJECT_ROOT = "typescript/kernel/protocol";

function projectFile(
  name: string,
  root: string,
  lint: NxProjectTarget
): NxProjectFile {
  return {
    name,
    path: `${root}/project.json`,
    project: {
      name,
      targets: { lint: { executor: "nx:run-commands", ...lint } },
    },
  };
}

function discovered(lint: NxProjectTarget): string[] {
  return discoverOxcProjects([
    projectFile("kernel-contract-protocol", PROJECT_ROOT, lint),
  ]).map((project) => project.name);
}

describe("Oxlint project-wide discovery", () => {
  test("credits a workspace-root cwd with the project path", () => {
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
        },
      })
    ).toEqual(["kernel-contract-protocol"]);
  });

  test("credits a project-root cwd with a bare dot", () => {
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware .",
          cwd: "typescript/kernel/protocol",
        },
      })
    ).toEqual(["kernel-contract-protocol"]);
  });

  test("credits a project-root cwd with no operand", () => {
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware",
          cwd: "./typescript/kernel/protocol/",
        },
      })
    ).toEqual(["kernel-contract-protocol"]);
  });

  test("rejects a partial src-only scope", () => {
    expect(
      discovered({
        options: {
          command:
            "bunx --bun oxlint --type-aware typescript/kernel/protocol/src",
          cwd: ".",
        },
      })
    ).toEqual([]);
  });

  test("rejects an extra ignore or scope option", () => {
    expect(
      discovered({
        options: {
          command:
            "bunx --bun oxlint --type-aware typescript/kernel/protocol --ignore-pattern src",
          cwd: ".",
        },
      })
    ).toEqual([]);
  });

  test("rejects explicit forwarded args", () => {
    // nx:run-commands appends `options.args` to the executed command
    // (normalizeOptions), so an extra `--ignore-pattern` narrows the real
    // scope even though the command text looks canonical.
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
          args: ["--ignore-pattern", "test/**"],
        },
      })
    ).toEqual([]);
  });

  test("rejects an unrecognized forwarded option", () => {
    // An unknown scalar option is forwarded as `--ignore-pattern=test/**`.
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
          "ignore-pattern": "test/**",
        },
      })
    ).toEqual([]);
  });

  test("rejects unparsed forwarded args", () => {
    // `__unparsed__` is re-emitted onto the executed command.
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
          __unparsed__: ["--ignore-pattern", "test/**"],
        },
      })
    ).toEqual([]);
  });

  test("rejects a custom executor with a canonical-looking command", () => {
    expect(
      discovered({
        executor: "custom:executor",
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
        },
      })
    ).toEqual([]);
  });

  test("rejects a wrong working directory", () => {
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware .",
          cwd: "typescript/kernel",
        },
      })
    ).toEqual([]);
  });

  test("rejects another project path and a parent-directory escape", () => {
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/runtime",
          cwd: ".",
        },
      })
    ).toEqual([]);
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware ..",
          cwd: "typescript/kernel/protocol/src",
        },
      })
    ).toEqual([]);
  });

  test("credits a single-command array", () => {
    expect(
      discovered({
        options: {
          commands: [
            "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          ],
          cwd: ".",
        },
      })
    ).toEqual(["kernel-contract-protocol"]);
  });

  test("rejects a multi-command target", () => {
    expect(
      discovered({
        options: {
          commands: [
            "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            "bunx --bun tsc --noEmit",
          ],
          cwd: ".",
        },
      })
    ).toEqual([]);
  });

  test("credits only the recognized code-plus-JSON composite", () => {
    const discoveredProjects = discoverNativeLintProjects([
      projectFile("kernel-contract-protocol", PROJECT_ROOT, {
        options: {
          commands: [
            "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            "bun tools/scripts/json-check.ts typescript/kernel/protocol",
          ],
          cwd: ".",
        },
      }),
    ]);
    expect(discoveredProjects.oxcProjects).toEqual([
      {
        jsonCompanion: true,
        name: "kernel-contract-protocol",
        root: PROJECT_ROOT,
      },
    ]);
    expect(discoveredProjects.jsonOnlyProjects).toEqual([]);
  });

  test("credits the exact JSON-only command without a zero-file Oxlint run", () => {
    const discoveredProjects = discoverNativeLintProjects([
      projectFile("kernel-json", PROJECT_ROOT, {
        options: {
          command:
            "bun tools/scripts/json-check.ts --json-only typescript/kernel/protocol",
          cwd: ".",
        },
      }),
    ]);
    expect(discoveredProjects.oxcProjects).toEqual([]);
    expect(discoveredProjects.jsonOnlyProjects).toEqual([
      { name: "kernel-json", root: PROJECT_ROOT },
    ]);
  });

  test("rejects malformed composites and JSON checker scope drift", () => {
    expect(
      discovered({
        options: {
          commands: [
            "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            "bun tools/scripts/json-check.ts typescript/kernel/runtime",
          ],
          cwd: ".",
        },
      })
    ).toEqual([]);
    expect(
      discovered({
        options: {
          commands: [
            "bun tools/scripts/json-check.ts typescript/kernel/protocol",
            "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          ],
          cwd: ".",
        },
      })
    ).toEqual([]);
  });

  test("ignores an unselected optional Oxlint configuration", () => {
    expect(
      discovered({
        configurations: {
          oxc: {
            command:
              "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            cwd: ".",
          },
        },
        options: {
          command: "bunx --bun @biomejs/biome check typescript/kernel/protocol",
          cwd: ".",
        },
      })
    ).toEqual([]);
  });

  test("honors the selected default configuration", () => {
    const base = {
      command: "bunx --bun @biomejs/biome check typescript/kernel/protocol",
      cwd: ".",
    };
    // Selecting the Oxlint configuration credits the project...
    expect(
      discovered({
        configurations: {
          oxc: {
            command:
              "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            cwd: ".",
          },
        },
        defaultConfiguration: "oxc",
        options: base,
      })
    ).toEqual(["kernel-contract-protocol"]);
    // ...while selecting the Biome configuration leaves an inactive Oxlint
    // alternative out of the gate.
    expect(
      discovered({
        configurations: {
          oxc: {
            command:
              "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            cwd: ".",
          },
        },
        defaultConfiguration: "biome",
        options: {
          command: "bunx --bun @biomejs/biome check typescript/kernel/protocol",
          cwd: ".",
        },
      })
    ).toEqual([]);
  });
});
