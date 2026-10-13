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

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectOxlintSelectedFiles,
  discoverNativeLintProjects,
  discoverOxcProjects,
} from "./native-lint-routing.js";
import { loadNxProjectFiles, targetCommandStrings } from "./nx-projects.js";
import type { NxProjectFile, NxProjectTarget } from "./nx-projects.js";

const PROJECT_ROOT = "typescript/kernel/protocol";

const projectFile = (
  name: string,
  root: string,
  lint: NxProjectTarget
): NxProjectFile => ({
  name,
  path: `${root}/project.json`,
  project: {
    name,
    targets: { lint: { executor: "nx:run-commands", ...lint } },
  },
});

const discovered = (lint: NxProjectTarget): string[] =>
  discoverOxcProjects([
    projectFile("kernel-contract-protocol", PROJECT_ROOT, lint),
  ]).map((project) => project.name);

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

  test("canonicalizes a Windows project root before Oxlint selection checks", async () => {
    const windowsProject = projectFile(
      "kernel-contract-protocol",
      PROJECT_ROOT,
      {
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
        },
      }
    );
    windowsProject.path = String.raw`typescript\kernel\protocol\project.json`;

    const projects = discoverOxcProjects([windowsProject], path.win32);
    expect(projects).toEqual([
      {
        jsonCompanion: false,
        name: "kernel-contract-protocol",
        root: PROJECT_ROOT,
      },
    ]);
    expect(
      await collectOxlintSelectedFiles(projects, {
        repoRoot: String.raw`C:\repo`,
        runCommand: mock().mockResolvedValue({
          code: 0,
          stderr: "",
          stdout: "typescript/kernel/protocol/src/index.ts\n",
        }),
      })
    ).toEqual(["typescript/kernel/protocol/src/index.ts"]);
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
          args: ["--ignore-pattern", "test/**"],
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
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
          __unparsed__: ["--ignore-pattern", "test/**"],
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          cwd: ".",
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

  test("rejects a command target that also supplies a commands array", () => {
    expect(
      discovered({
        options: {
          command: "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          commands: [
            "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            "bun tools/scripts/json-check.ts typescript/kernel/protocol",
          ],
          cwd: ".",
        },
      })
    ).toEqual([]);
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
          parallel: false,
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
          parallel: false,
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

  test("rejects mixed commands without explicit serial execution", () => {
    for (const parallel of [undefined, true, "false", 0]) {
      const options = {
        commands: [
          "bunx --bun oxlint --type-aware typescript/kernel/protocol",
          "bun tools/scripts/json-check.ts typescript/kernel/protocol",
        ],
        cwd: ".",
        ...(parallel === undefined ? {} : { parallel }),
      };
      expect(discovered({ options })).toEqual([]);
    }
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
          parallel: false,
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
          parallel: false,
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

const withProjectFixture = (
  value: unknown,
  check: (root: string) => void
): void => {
  const root = mkdtempSync(path.join(tmpdir(), "nx-project-loader-"));
  try {
    writeFileSync(path.join(root, "project.json"), JSON.stringify(value));
    check(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("Nx project input validation", () => {
  test("preserves executor-specific fields that collide with command option names", () => {
    const project = {
      name: "fixture",
      targets: {
        lint: {
          configurations: {
            custom: {
              __unparsed__: false,
              args: { mode: "custom" },
              command: 3,
              commands: { custom: true },
              cwd: ["custom"],
              forwardAllArgs: "custom",
            },
          },
          defaultConfiguration: "custom",
          executor: "custom:executor",
          inputs: [
            "default",
            { dependentTasksOutputFiles: "**/*.ts", transitive: true },
          ],
          options: {
            __unparsed__: { custom: true },
            args: { include: ["custom"] },
            command:
              "bunx --bun oxlint --type-aware typescript/kernel/protocol",
            commands: [null, { command: false }, "bun custom.ts"],
            cwd: { root: "custom" },
            forwardAllArgs: [false],
          },
        },
      },
    };
    withProjectFixture(project, (root) => {
      const [loaded] = loadNxProjectFiles(root);
      expect(loaded?.project).toEqual(project);
      const lint = loaded?.project.targets?.lint;
      if (lint === undefined) {
        throw new Error("expected the fixture lint target");
      }
      expect(targetCommandStrings(lint)).toEqual([]);
      expect(discovered(lint)).toEqual([]);
    });
  });

  test("does not treat opaque executor metadata as execution proof", () => {
    const harnessCommand = "bun tools/conformance/harness/run.ts";
    for (const executor of ["custom:executor", undefined, "nx:run-script"]) {
      const target = {
        ...(executor === undefined ? {} : { executor }),
        configurations: {
          custom: {
            command: harnessCommand,
            commands: [{ command: "cargo test" }],
          },
        },
        options: {
          command: "cargo test",
          commands: [null, harnessCommand],
        },
      };
      const project = { name: "fixture", targets: { test: target } };
      withProjectFixture(project, (root) => {
        const [loaded] = loadNxProjectFiles(root);
        expect(loaded?.project).toEqual(project);
        const testTarget = loaded?.project.targets?.test;
        if (testTarget === undefined) {
          throw new Error("expected the fixture test target");
        }
        expect(targetCommandStrings(testTarget)).toEqual([]);
      });
    }
  });

  test("extracts canonical command strings from each supported shape", () => {
    const command = "bun tools/conformance/harness/run.ts";
    for (const options of [
      { command },
      { commands: [command] },
      { commands: [{ command }] },
    ]) {
      expect(
        targetCommandStrings({ executor: "nx:run-commands", options })
      ).toEqual([command]);
      expect(
        targetCommandStrings({
          configurations: { alternate: options },
          executor: "nx:run-commands",
        })
      ).toEqual([command]);
    }
  });

  test("does not extract partial execution proof from malformed canonical commands", () => {
    const command = "bun tools/conformance/harness/run.ts";
    for (const options of [
      { command: false },
      { command, commands: [command] },
      { commands: "invalid" },
      ...[null, false, {}, { command: false }, [command]].map((entry) => ({
        commands: [entry, command],
      })),
    ]) {
      for (const target of [
        { executor: "nx:run-commands", options },
        {
          configurations: { alternate: options },
          executor: "nx:run-commands",
          options: { command },
        },
      ]) {
        withProjectFixture(
          { name: "fixture", targets: { test: target } },
          (root) => {
            const [loaded] = loadNxProjectFiles(root);
            const testTarget = loaded?.project.targets?.test;
            if (testTarget === undefined) {
              throw new Error("expected the fixture test target");
            }
            expect(() => targetCommandStrings(testTarget)).toThrow(
              "invalid nx:run-commands"
            );
          }
        );
      }
    }
  });

  test("gives malformed canonical command options no native credit", () => {
    const command = "bunx --bun oxlint --type-aware typescript/kernel/protocol";
    const malformedOptions = [
      { command: 3 },
      { command, cwd: false },
      { commands: "invalid" },
      { commands: { command } },
      { commands: [null] },
      { commands: [{ command: false }] },
      { commands: [[command]] },
      { args: { custom: true }, command },
      { __unparsed__: [false], command },
      { command, forwardAllArgs: "false" },
    ];
    for (const options of malformedOptions) {
      for (const lint of [
        { executor: "nx:run-commands", options },
        {
          configurations: { native: options },
          defaultConfiguration: "native",
          executor: "nx:run-commands",
          options: { command },
        },
      ]) {
        withProjectFixture({ name: "fixture", targets: { lint } }, (root) => {
          const [loaded] = loadNxProjectFiles(root);
          const loadedLint = loaded?.project.targets?.lint;
          if (loadedLint === undefined) {
            throw new Error("expected the fixture lint target");
          }
          expect(loaded?.project).toEqual({
            name: "fixture",
            targets: { lint },
          });
          expect(discovered(loadedLint)).toEqual([]);
        });
      }
    }
  });

  test("rejects malformed known command fields in base and effective configurations", () => {
    const command = "bun tools/conformance/harness/run.ts";
    const malformedFields = [
      { args: { invalid: true } },
      { args: [false] },
      { args: null },
      { cwd: false },
      { __unparsed__: "--flag" },
      { __unparsed__: [false] },
      { forwardAllArgs: "false" },
    ];
    for (const fields of malformedFields) {
      const targets: NxProjectTarget[] = [
        { executor: "nx:run-commands", options: { command, ...fields } },
        {
          configurations: { native: fields },
          defaultConfiguration: "native",
          executor: "nx:run-commands",
          options: { command },
        },
        {
          configurations: { alternate: fields },
          executor: "nx:run-commands",
          options: { command },
        },
      ];
      for (const target of targets) {
        withProjectFixture(
          { name: "fixture", targets: { test: target } },
          (root) => {
            const [loaded] = loadNxProjectFiles(root);
            expect(loaded?.project).toEqual({
              name: "fixture",
              targets: { test: target },
            });
            expect(() =>
              targetCommandStrings(loaded?.project.targets?.test ?? {})
            ).toThrow("invalid nx:run-commands");
          }
        );
      }
    }
  });

  test("rejects malformed command object fields without partial proof", () => {
    const command = "bun tools/conformance/harness/run.ts";
    for (const fields of [
      { forwardAllArgs: "false" },
      { prefix: false },
      { prefixColor: "orange" },
      { color: "orange" },
      { bgColor: "red" },
      { description: false },
      { unknown: true },
    ]) {
      const options = { commands: [command, { command, ...fields }] };
      expect(() =>
        targetCommandStrings({ executor: "nx:run-commands", options })
      ).toThrow("invalid nx:run-commands");
      expect(() =>
        targetCommandStrings({
          configurations: { native: options },
          defaultConfiguration: "native",
          executor: "nx:run-commands",
          options: { commands: [command] },
        })
      ).toThrow("invalid nx:run-commands");
    }
  });

  test("rejects conflicting command shapes after configuration merging", () => {
    const command = "bun tools/conformance/harness/run.ts";
    for (const [options, native] of [
      [{ command }, { commands: [command] }],
      [{ commands: [command] }, { command }],
    ]) {
      expect(() =>
        targetCommandStrings({
          configurations: { native },
          defaultConfiguration: "native",
          executor: "nx:run-commands",
          options,
        })
      ).toThrow("invalid nx:run-commands");
    }
  });

  test("preserves base commands for missing and empty default configurations", () => {
    const command = "bun tools/conformance/harness/run.ts";
    for (const defaultConfiguration of ["missing", ""]) {
      const target = {
        defaultConfiguration,
        executor: "nx:run-commands",
        options: { command },
      };
      expect(targetCommandStrings(target)).toEqual([command]);
      expect(
        targetCommandStrings({
          ...target,
          configurations: { alternate: { command: "bun alternate.ts" } },
        })
      ).toEqual([command, "bun alternate.ts"]);
    }
  });

  test("accepts valid command fields, object enums and commandless configuration fragments", () => {
    const command = "bun tools/conformance/harness/run.ts";
    for (const color of [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
    ]) {
      expect(
        targetCommandStrings({
          configurations: { native: { args: "--native" } },
          defaultConfiguration: "native",
          executor: "nx:run-commands",
          options: {
            __unparsed__: ["--flag"],
            args: ["--flag"],
            commands: [
              {
                bgColor: `bg${color.charAt(0).toUpperCase()}${color.slice(1)}`,
                color,
                command,
                description: "fixture",
                forwardAllArgs: false,
                prefix: "fixture",
                prefixColor: color,
              },
            ],
            cwd: ".",
            forwardAllArgs: false,
            parallel: true,
          },
        })
      ).toEqual([command]);
    }
  });

  test("preserves alternate commands, configurations and custom metadata", () => {
    const project = {
      customMetadata: { owner: "fixture" },
      name: "fixture",
      tags: ["tooling"],
      targets: {
        custom: { executor: "custom:executor", options: { customScalar: 3 } },
        lint: {
          configurations: {
            native: { args: "--flag", commands: ["bun native.ts"] },
          },
          customTargetMetadata: true,
          defaultConfiguration: "native",
          executor: "nx:run-commands",
          options: {
            __unparsed__: ["--other"],
            args: ["--flag"],
            commands: [
              "bun first.ts",
              { command: "bun second.ts", forwardAllArgs: false },
            ],
            customOption: { nested: true },
            cwd: ".",
            forwardAllArgs: true,
            parallel: false,
          },
        },
      },
    };
    withProjectFixture(project, (root) => {
      const [loaded] = loadNxProjectFiles(root);
      expect(loaded?.project).toEqual(project);
      expect(loaded?.name).toBe("fixture");
      const lint = loaded?.project.targets?.lint;
      if (lint === undefined) {
        throw new Error("expected the fixture lint target");
      }
      expect(targetCommandStrings(lint)).toEqual([
        "bun first.ts",
        "bun second.ts",
        "bun native.ts",
      ]);
    });
  });

  test("reports a missing string name before malformed optional fields", () => {
    withProjectFixture({ name: 3, targets: [] }, (root) => {
      expect(() => loadNxProjectFiles(root)).toThrow(
        "project.json without a string name at project.json — the discovery gates cannot index it; add an explicit name"
      );
    });
  });

  test("rejects malformed declared optional fields without dropping the project", () => {
    const invalidFields = [
      { tags: [3] },
      { targets: [] },
      { targets: { lint: null } },
      { targets: { lint: { executor: 3 } } },
      { targets: { lint: { defaultConfiguration: false } } },
      { targets: { lint: { configurations: [] } } },
      { targets: { lint: { configurations: { native: null } } } },
      { targets: { lint: { options: null } } },
      { targets: { lint: { options: [] } } },
    ];
    for (const fields of invalidFields) {
      withProjectFixture({ name: "fixture", ...fields }, (root) => {
        expect(() => loadNxProjectFiles(root)).toThrow(
          "invalid project.json fields at project.json"
        );
      });
    }
  });
});

describe("serial Oxlint selection", () => {
  const projects = [
    { jsonCompanion: false, name: "first", root: "typescript/first" },
    { jsonCompanion: false, name: "second", root: "typescript/second" },
  ];

  test("waits for each selection before launching the next project", async () => {
    const first = Promise.withResolvers<{
      code: number;
      stderr: string;
      stdout: string;
    }>();
    const started = Promise.withResolvers<boolean>();
    const commands: (readonly string[])[] = [];
    const run = async (command: readonly string[]) => {
      commands.push(command);
      if (commands.length === 1) {
        started.resolve(true);
        return await first.promise;
      }
      return { code: 0, stderr: "", stdout: "typescript/second/main.ts\n" };
    };
    const selection = collectOxlintSelectedFiles(projects, {
      repoRoot: "/repo",
      runCommand: run,
    });
    await started.promise;
    expect(commands).toHaveLength(1);
    first.resolve({
      code: 0,
      stderr: "",
      stdout: "typescript/first/main.ts\n",
    });
    expect(await selection).toEqual([
      "typescript/first/main.ts",
      "typescript/second/main.ts",
    ]);
    expect(commands.map((command) => command[4])).toEqual([
      "typescript/first",
      "typescript/second",
    ]);
  });

  test("stops at the first failed selection and preserves its message", async () => {
    const run = mock().mockResolvedValue({
      code: 7,
      stderr: "failure",
      stdout: "",
    });
    let failure: unknown;
    try {
      await collectOxlintSelectedFiles(projects, {
        repoRoot: "/repo",
        runCommand: run,
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected selection to fail");
    }
    expect(failure.message).toBe(
      "Oxlint file selection for first exited with code 7"
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
