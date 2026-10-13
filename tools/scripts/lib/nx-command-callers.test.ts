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

// Exercise the real discovery callers with controlled inputs in isolated children.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { spawnSync } from "bun";

import { discoverNativeLintProjects } from "./native-lint-routing.js";
import { targetCommandStrings } from "./nx-projects.js";
import type { NxProjectTarget } from "./nx-projects.js";

const HARNESS = "bun tools/conformance/harness/run.ts";
const CARGO = "cargo test";
const RUN = "nx:run-commands";

interface CallerScenario {
  name: string;
  target: NxProjectTarget;
  classified?: boolean;
  outcome?: "present" | "absent";
}

// Keep the callers' grading intact: replace only their discovery input and
// intercept process.exit inside one isolated process, without copying checks.
const runDiscoveryCaller = (
  caller: "certification" | "coverage",
  scenarios: CallerScenario[]
): unknown[] => {
  const callerPath = path.resolve(
    caller === "certification"
      ? "tools/conformance/certification/validate-certification-discovery.ts"
      : "tools/scripts/validate-workspace-test-coverage.ts"
  );
  const source = readFileSync(callerPath, "utf-8")
    .replace("#!/usr/bin/env bun\n", "")
    .replace("loadNxProjectFiles,", "loadNxProjectFiles as realDiscovery,")
    .replace(
      caller === "certification"
        ? "../../scripts/lib/nx-projects.js"
        : "./lib/nx-projects.js",
      pathToFileURL(path.resolve("tools/scripts/lib/nx-projects.ts")).href
    )
    .replace(
      '"./verify.js"',
      JSON.stringify(
        pathToFileURL(path.resolve("tools/scripts/verify.ts")).href
      )
    );
  const child = spawnSync(
    [
      process.execPath,
      "--eval",
      `
      const { readFileSync } = await import('node:fs');
      const { source, caller, scenarios } = JSON.parse(readFileSync(0, 'utf8'));
      const injected = source + '\\n';
      const discovery = caller === 'certification'
        ? "const baseline = globalThis.baseline ??= realDiscovery(process.cwd()); const loadNxProjectFiles = () => [...baseline, globalThis.fixture];\\n"
        : "const baseline = globalThis.baseline ??= realDiscovery(process.cwd()); const loadNxProjectFiles = () => baseline.map(file => file.name === 'kernel-rust-kernel' ? globalThis.fixture : file);\\n";
      const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(discovery + injected);
      class CallerExit extends Error { constructor(code) { super(); this.code = code; } }
      process.exit = code => { throw new CallerExit(code); };
      const results = [];
      for (const [index, scenario] of scenarios.entries()) {
        globalThis.fixture = {
          name: caller === 'certification' ? 'fixture' : 'kernel-rust-kernel',
          path: 'fixture/project.json',
          project: {
            tags: scenario.classified ? ['layer:testkit'] : [],
            targets: { [caller === 'certification' ? 'probe' : 'test']: scenario.target }
          }
        };
        const stdout = [], stderr = [];
        console.log = (...args) => stdout.push(args.join(' '));
        console.error = (...args) => stderr.push(args.join(' '));
        let exit = 0;
        try {
          await import('data:text/javascript;base64,' + Buffer.from(js + '\\n//' + index).toString('base64'));
        } catch (error) {
          exit = error instanceof CallerExit ? error.code : 1;
          if (!(error instanceof CallerExit)) stderr.push(String(error));
        }
        results.push({ name: scenario.name, exit, stdout: stdout.join('\\n'), stderr: stderr.join('\\n') });
      }
      process.stdout.write(JSON.stringify(results));
      `,
    ],
    {
      cwd: process.cwd(),
      stdin: new TextEncoder().encode(
        JSON.stringify({ caller, scenarios, source })
      ),
    }
  );
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const results: unknown = JSON.parse(child.stdout.toString());
  if (!Array.isArray(results)) {
    throw new TypeError("expected discovery caller results");
  }
  return results;
};
const arrayScenarios = (command: string, other: string): CallerScenario[] => {
  const scenarios: CallerScenario[] = [];
  const array = command.split(" ");
  const otherArray = other.split(" ");
  const validArrays: {
    name: string;
    base?: string | string[];
    override?: string | string[];
    outcome: "present" | "absent";
  }[] = [
    {
      base: command,
      name: "base string/config other array",
      outcome: "present",
      override: otherArray,
    },
    {
      base: other,
      name: "base other string/config array",
      outcome: "present",
      override: array,
    },
    {
      base: array,
      name: "base array/config other string",
      outcome: "present",
      override: other,
    },
    {
      base: otherArray,
      name: "base other array/config string",
      outcome: "present",
      override: command,
    },
    {
      base: array,
      name: "base array/config array",
      outcome: "present",
      override: otherArray,
    },
    {
      base: otherArray,
      name: "base other array/config array",
      outcome: "present",
      override: array,
    },
    { base: array, name: "standalone split array", outcome: "present" },
    { name: "configuration-only array", outcome: "present", override: array },
    { base: [], name: "empty array", outcome: "absent" },
    { base: ["", ""], name: "empty strings", outcome: "absent" },
    { base: "", name: "empty string", outcome: "absent" },
    {
      base: command,
      name: "base string/empty array",
      outcome: "present",
      override: [],
    },
    {
      base: [],
      name: "base empty array/config string",
      outcome: "present",
      override: command,
    },
    {
      base: array,
      name: "base array/empty array",
      outcome: "present",
      override: [],
    },
    {
      base: ["", command, ""],
      name: "spaces and empty elements",
      outcome: "present",
    },
    {
      base: [...array, '"two words"'],
      name: "quoted unrelated suffix",
      outcome: "present",
    },
    {
      base: otherArray,
      name: "other arrays only",
      outcome: "absent",
      override: [],
    },
  ];
  for (const entry of validArrays) {
    for (const defaultConfiguration of [undefined, "array", "missing", ""]) {
      scenarios.push({
        name: `${entry.name}:${defaultConfiguration}`,
        outcome: entry.outcome,
        target: {
          executor: RUN,
          ...(entry.base === undefined
            ? {}
            : { options: { command: entry.base } }),
          ...(entry.override === undefined
            ? {}
            : { configurations: { array: { command: entry.override } } }),
          ...(defaultConfiguration === undefined
            ? {}
            : { defaultConfiguration }),
        },
      });
    }
  }
  for (const commandArray of [
    [command, null],
    [null, command],
    [command, 3],
    [false, command],
    [[command]],
    [{ command }],
  ]) {
    for (const position of ["base", "default", "inactive"] as const) {
      scenarios.push({
        name: `mixed array ${JSON.stringify(commandArray)}:${position}`,
        target: {
          executor: RUN,
          options: { command: position === "base" ? commandArray : array },
          ...(position === "base"
            ? {}
            : {
                configurations: { bad: { command: commandArray } },
                defaultConfiguration:
                  position === "default" ? "bad" : "missing",
              }),
        },
      });
    }
  }
  for (const target of [
    { options: { command: array, commands: [command] } },
    {
      configurations: { bad: { commands: [command] } },
      options: { command: array },
    },
    {
      configurations: { bad: { command: array } },
      options: { commands: [command] },
    },
  ]) {
    scenarios.push({
      name: "array conflict",
      target: { ...target, executor: RUN },
    });
  }
  return scenarios;
};

test("actual absence and presence callers preserve valid controls and fail explicitly on invalid metadata", () => {
  const invalidMessage: unknown = expect.stringContaining(
    "TypeError: invalid nx:run-commands"
  );
  const successMessage: unknown = expect.stringContaining(": OK");
  for (const caller of ["certification", "coverage"] as const) {
    const failureMessage: unknown = expect.stringContaining(
      caller === "certification"
        ? "invokes the shared engine"
        : "no longer invokes cargo"
    );
    const command = caller === "certification" ? HARNESS : CARGO;
    const scenarios: CallerScenario[] = [
      {
        name: "valid",
        outcome: "present",
        target: { executor: RUN, options: { command } },
      },
      {
        classified: true,
        name: "classified",
        outcome: "present",
        target: { executor: RUN, options: { command } },
      },
      {
        name: "other literal",
        outcome: "absent",
        target: {
          executor: RUN,
          options: { command: caller === "certification" ? CARGO : HARNESS },
        },
      },
      {
        name: "normalized array",
        outcome: "present",
        target: { executor: RUN, options: { command: [command] } },
      },
    ];
    for (const executor of [undefined, "custom:executor", "nx:run-script"]) {
      scenarios.push({
        name: `opaque:${executor}`,
        outcome: "absent",
        target: { executor, options: { command, parallel: "invalid" } },
      });
    }
    // Representative of every top-level and nested field, plus required
    // command entries and merge conflicts; nx-command-options.test.ts covers
    // the full value matrix.
    const invalidOptions = [
      ...[
        "command",
        "commands",
        "parallel",
        "color",
        "readyWhen",
        "args",
        "envFile",
        "cwd",
        "env",
        "__unparsed__",
        "forwardAllArgs",
        "tty",
      ].map((key) =>
        key === "commands" ? { commands: null } : { command, [key]: null }
      ),
      ...[
        "command",
        "forwardAllArgs",
        "prefix",
        "description",
        "color",
        "prefixColor",
        "bgColor",
        "unknown",
      ].map((key) => ({ commands: [command, { command, [key]: null }] })),
      { commands: [command, {}] },
    ];
    for (const [index, options] of invalidOptions.entries()) {
      for (const position of ["base", "default", "inactive"] as const) {
        scenarios.push({
          name: `invalid ${index}:${position}`,
          target:
            position === "base"
              ? { executor: RUN, options }
              : {
                  configurations: { bad: options, valid: { command } },
                  defaultConfiguration:
                    position === "default" ? "bad" : "valid",
                  executor: RUN,
                  options: {},
                },
        });
      }
    }
    scenarios.push(
      {
        name: "inactive invalid field",
        target: {
          configurations: { unused: { parallel: "invalid" } },
          executor: RUN,
          options: { command },
        },
      },
      {
        name: "effective conflict",
        target: {
          configurations: { unused: { commands: [command] } },
          executor: RUN,
          options: { command },
        },
      },
      ...arrayScenarios(command, caller === "certification" ? CARGO : HARNESS)
    );
    const results = runDiscoveryCaller(caller, scenarios);
    expect(results).toHaveLength(scenarios.length);
    for (const [index, result] of results.entries()) {
      const scenario = scenarios[index];
      if (scenario?.outcome === undefined) {
        expect(result).toMatchObject({
          exit: 1,
          name: scenarios[index]?.name,
          stderr: invalidMessage,
          stdout: "",
        });
      } else {
        const passes =
          caller === "certification"
            ? scenario.outcome === "absent" || scenario.classified === true
            : scenario.outcome === "present";
        expect(result).toMatchObject({
          exit: passes ? 0 : 1,
          name: scenarios[index]?.name,
        });
        expect(result).toMatchObject(
          passes
            ? { stderr: "", stdout: successMessage }
            : {
                stderr: failureMessage,
                stdout: "",
              }
        );
      }
    }
  }
});

test("preserves exact command-array joins without expanding strict native scope credit", () => {
  const command = "bunx --bun oxlint --type-aware typescript/kernel/protocol";
  const joins: [string[], string][] = [
    [[], ""],
    [[""], ""],
    [["", ""], " "],
    [["cargo", "test"], "cargo test"],
    [[" cargo ", " test "], " cargo   test "],
    [["bun", '"two words"', ""], 'bun "two words" '],
    [["a\tb", "c\nd"], "a\tb c\nd"],
    [["{args.value}", "$VALUE", "&&"], "{args.value} $VALUE &&"],
    [command.split(" "), command],
  ];
  for (const [array, joined] of joins) {
    expect(
      targetCommandStrings({ executor: RUN, options: { command: array } })
    ).toEqual([joined]);
    for (const target of [
      { executor: RUN, options: { command: array } },
      {
        configurations: { array: { command: array } },
        defaultConfiguration: "array",
        executor: RUN,
        options: { command },
      },
    ]) {
      expect(
        discoverNativeLintProjects([
          {
            name: "fixture",
            path: "typescript/kernel/protocol/project.json",
            project: { targets: { lint: target } },
          },
        ])
      ).toEqual({ jsonOnlyProjects: [], oxcProjects: [] });
    }
  }
});

test("array metadata preserves conflict-first, base-first and configuration-first errors without values", () => {
  const options = { command: ["cargo", "test"] };
  const checks: [NxProjectTarget, string][] = [
    [
      {
        configurations: { later: { command: [null] } },
        options: { ...options, env: { PRIVATE: 42 } },
      },
      "options: env",
    ],
    [
      { options: { command: [null], commands: [], parallel: "invalid" } },
      "options: command/commands conflict",
    ],
    [
      {
        configurations: { first: { command: [null] }, second: { env: false } },
        options,
      },
      'configurations["first"] (effective options): command',
    ],
    [
      {
        configurations: {
          first: { commands: [], env: false },
          second: { command: [null] },
        },
        options,
      },
      'configurations["first"] (effective options): command/commands conflict',
    ],
  ];
  for (const [target, context] of checks) {
    expect(() => targetCommandStrings({ ...target, executor: RUN })).toThrow(
      new TypeError(`invalid nx:run-commands ${context}`)
    );
  }
});
