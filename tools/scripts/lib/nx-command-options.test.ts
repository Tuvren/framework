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

// Installed Nx is the independent reference for this literal-command inventory.
// Runtime interpolation, argv rewriting and graph defaults remain outside it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnSync } from "bun";

import { discoverNativeLintProjects } from "./native-lint-routing.js";
import { loadNxProjectFiles, targetCommandStrings } from "./nx-projects.js";
import type { NxProjectTarget } from "./nx-projects.js";

const HARNESS = "bun tools/conformance/harness/run.ts";
const CARGO = "cargo test";
const COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];
const BACKGROUNDS = [
  "bgBlack",
  "bgRed",
  "bgGreen",
  "bgYellow",
  "bgBlue",
  "bgMagenta",
  "bgCyan",
  "bgWhite",
];
interface OptionCase {
  name: string;
  options: Record<string, unknown>;
  valid: boolean;
  proof: string[];
}
const cases: OptionCase[] = [];
const add = (
  name: string,
  options: Record<string, unknown>,
  valid: boolean,
  proof: string[]
): void => {
  cases.push({ name, options, proof, valid });
};
const fieldCases = (
  key: string,
  valid: unknown[],
  invalid: unknown[]
): void => {
  for (const [values, accepted] of [
    [valid, true],
    [invalid, false],
  ] as const) {
    for (const value of values) {
      const options =
        key === "commands"
          ? { commands: value }
          : { command: HARNESS, [key]: value };
      let proof = accepted ? [HARNESS] : [];
      if (key === "command") {
        proof = [];
        if (typeof value === "string") {
          proof = [value];
        } else if (accepted && Array.isArray(value)) {
          proof = [value.join(" ")];
        }
      }
      if (key === "commands") {
        proof =
          accepted && Array.isArray(value) && value.length > 0 ? [HARNESS] : [];
      }
      add(`${key}:${JSON.stringify(value)}`, options, accepted, proof);
    }
  }
};
const invalidScalars = [null, false, 3, [], {}];
for (const key of ["parallel", "color", "forwardAllArgs", "tty"]) {
  fieldCases(key, [true, false], [null, 3, "false", [], {}]);
}
for (const key of ["cwd", "envFile"]) {
  fieldCases(key, ["", "."], invalidScalars);
}
for (const key of ["command", "readyWhen", "args"]) {
  fieldCases(
    key,
    [
      "",
      HARNESS,
      [],
      [HARNESS, CARGO],
      [""],
      ["", ""],
      ["cargo", "test"],
      [" cargo ", " test "],
      ["bun", '"two words"', ""],
    ],
    [
      null,
      false,
      3,
      {},
      [null],
      [3],
      [false],
      ["ok", null],
      [null, "ok"],
      ["ok", 3],
      [3, "ok"],
      ["ok", false],
      [false, "ok"],
      [[]],
      [{}],
    ]
  );
}
fieldCases(
  "__unparsed__",
  [[], ["a", "b"]],
  [
    null,
    false,
    3,
    "a",
    {},
    [null],
    [3],
    [false],
    ["a", null],
    [null, "a"],
    ["a", 3],
    [3, "a"],
    ["a", false],
    [false, "a"],
    [[]],
    [{}],
  ]
);
fieldCases(
  "env",
  [{}, { A: "" }, { A: "1", B: "2" }],
  [
    null,
    false,
    3,
    "invalid",
    [],
    ["a"],
    { A: false },
    { A: 3 },
    { A: "1", B: 3 },
    { A: 3, B: "2" },
    { A: "1", B: false },
    { A: false, B: "2" },
    { A: null },
    { A: [] },
    { A: {} },
  ]
);
fieldCases(
  "commands",
  [[], [HARNESS], [{ command: HARNESS }]],
  [null, false, 3, "invalid", {}]
);
for (const entry of [
  null,
  false,
  3,
  [],
  {},
  { command: false },
  { command: [] },
]) {
  for (const commands of [
    [entry, HARNESS],
    [HARNESS, entry],
  ]) {
    add(`commands:${JSON.stringify(commands)}`, { commands }, false, []);
  }
}
for (const [key, valid, invalid] of [
  ["command", ["", HARNESS], invalidScalars],
  ["forwardAllArgs", [true, false], [null, 3, "false", [], {}]],
  ["prefix", ["", "fixture"], invalidScalars],
  ["description", ["", "fixture"], invalidScalars],
  ["prefixColor", COLORS, [null, false, 3, [], {}, "orange", "bgRed"]],
  ["color", COLORS, [null, false, 3, [], {}, "orange", "bgRed"]],
  ["bgColor", BACKGROUNDS, [null, false, 3, [], {}, "red", "bgOrange"]],
  ["unknown", [], [null, false, 3, "x", [], {}]],
] as const) {
  for (const [values, accepted] of [
    [valid, true],
    [invalid, false],
  ] as const) {
    for (const value of values) {
      const entry = { command: HARNESS, [key]: value };
      for (const commands of [
        [CARGO, entry],
        [entry, CARGO],
      ]) {
        const literal =
          typeof entry.command === "string" ? entry.command : HARNESS;
        add(
          `nested ${key}:${JSON.stringify(commands)}`,
          { commands },
          accepted,
          accepted
            ? commands.map((item) =>
                typeof item === "string" ? item : literal
              )
            : []
        );
      }
    }
  }
}
for (const key of [
  "unknown",
  "usePty",
  "streamOutput",
  "verbose",
  "no-color",
  "no-parallel",
]) {
  for (const value of [null, false, 3, "x", ["x"], { nested: true }]) {
    add(
      `${key}:${JSON.stringify(value)}`,
      { command: HARNESS, [key]: value },
      true,
      [HARNESS]
    );
  }
}
add("both command shapes", { command: HARNESS, commands: [CARGO] }, false, []);
add("commandless fragment", {}, false, []);

const RUN = "nx:run-commands";
const discover = (lint: NxProjectTarget) =>
  discoverNativeLintProjects([
    {
      name: "fixture",
      path: "typescript/kernel/protocol/project.json",
      project: { targets: { lint: { ...lint, executor: RUN } } },
    },
  ]);
const replaceLiteral = (value: unknown, command: string): unknown => {
  if (typeof value === "string") {
    return value.replaceAll(HARNESS, command);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceLiteral(entry, command));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        replaceLiteral(field, command),
      ])
    );
  }
  return value;
};
const withCommand = (
  options: Record<string, unknown>,
  command: string
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(options).map(([key, field]) => [
      key,
      replaceLiteral(field, command),
    ])
  );

const schemaConstraints = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(schemaConstraints);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, untypedField] of Object.entries(value)) {
    const field: unknown = untypedField;
    if (
      [
        "type",
        "oneOf",
        "properties",
        "items",
        "enum",
        "required",
        "additionalProperties",
      ].includes(key)
    ) {
      result[key] =
        key === "properties" && field !== null && typeof field === "object"
          ? Object.fromEntries(
              Object.entries(field).map(([name, property]) => [
                name,
                schemaConstraints(property),
              ])
            )
          : schemaConstraints(field);
    }
  }
  return result;
};

describe("complete installed run-commands boundary", () => {
  test("reports stable base-first and named effective-configuration failure context", () => {
    const target = {
      configurations: { 'unused"quoted': { env: false } },
      executor: RUN,
      options: { command: HARNESS, parallel: "invalid" },
    };
    expect(() => targetCommandStrings(target)).toThrow(
      new TypeError("invalid nx:run-commands options: parallel")
    );
    expect(() =>
      targetCommandStrings({
        ...target,
        options: { command: HARNESS },
      })
    ).toThrow(
      new TypeError(
        'invalid nx:run-commands configurations["unused\\"quoted"] (effective options): env'
      )
    );
    expect(() =>
      targetCommandStrings({
        executor: RUN,
        options: { command: HARNESS, commands: [CARGO], parallel: "invalid" },
      })
    ).toThrow(
      new TypeError(
        "invalid nx:run-commands options: command/commands conflict"
      )
    );
    expect(() =>
      targetCommandStrings({
        configurations: {
          first: { parallel: "invalid" },
          second: { env: false },
        },
        executor: RUN,
        options: { command: HARNESS },
      })
    ).toThrow(
      new TypeError(
        'invalid nx:run-commands configurations["first"] (effective options): parallel'
      )
    );
  });

  test("keeps all raw executor metadata opaque and structured inputs intact in the loader", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nx-command-options-"));
    try {
      for (const { options } of cases) {
        for (const executor of [
          RUN,
          "custom:executor",
          "nx:run-script",
          undefined,
        ]) {
          const target = {
            configurations: { native: options },
            customTargetMetadata: { owner: "fixture" },
            defaultConfiguration: "native",
            ...(executor === undefined ? {} : { executor }),
            inputs: [
              "default",
              { dependentTasksOutputFiles: "**/*.d.ts", transitive: true },
            ],
            options,
          };
          const project = {
            customMetadata: [null, { owner: "fixture" }],
            name: "fixture",
            targets: { test: target },
          };
          writeFileSync(
            path.join(root, "project.json"),
            JSON.stringify(project)
          );
          const [loaded] = loadNxProjectFiles(root);
          expect(loaded?.project).toEqual(project);
          if (executor !== RUN) {
            expect(
              targetCommandStrings(loaded?.project.targets?.test ?? {})
            ).toEqual([]);
          }
        }
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("pins every installed field, nested field, enum and structural constraint", () => {
    const require = createRequire(import.meta.url);
    const schema: unknown = JSON.parse(
      readFileSync(
        require.resolve("nx/src/executors/run-commands/schema.json"),
        "utf-8"
      )
    );
    const string = { type: "string" };
    const boolean = { type: "boolean" };
    const strings = { items: string, type: "array" };
    expect(schemaConstraints(schema)).toEqual({
      additionalProperties: true,
      oneOf: [{ required: ["commands"] }, { required: ["command"] }],
      properties: {
        __unparsed__: strings,
        args: { oneOf: [strings, string] },
        color: boolean,
        command: { oneOf: [strings, string], type: "string" },
        commands: {
          items: {
            oneOf: [
              {
                additionalProperties: false,
                properties: {
                  bgColor: { enum: BACKGROUNDS, type: "string" },
                  color: { enum: COLORS, type: "string" },
                  command: string,
                  description: string,
                  forwardAllArgs: boolean,
                  prefix: string,
                  prefixColor: { enum: COLORS, type: "string" },
                },
                required: ["command"],
                type: "object",
              },
              string,
            ],
          },
          type: "array",
        },
        cwd: string,
        env: { additionalProperties: string, type: "object" },
        envFile: string,
        forwardAllArgs: boolean,
        parallel: boolean,
        readyWhen: { oneOf: [string, strings] },
        tty: boolean,
      },
      type: "object",
    });
  });

  test("compares the complete field matrix against one isolated installed Nx validator", () => {
    const child = spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { createRequire } = await import('node:module');
      const { readFileSync } = await import('node:fs');
      const require = createRequire(process.cwd() + '/package.json');
      const schema = JSON.parse(readFileSync(require.resolve('nx/src/executors/run-commands/schema.json'), 'utf8'));
      const { validateOptsAgainstSchema } = await import(require.resolve('nx/src/utils/params'));
      const cases = JSON.parse(readFileSync(0, 'utf8'));
      // Expose the installed private normalizer only inside this reference child.
      const { Module } = require('node:module');
      const implPath = require.resolve('nx/src/executors/run-commands/run-commands.impl');
      const vendor = new Module(implPath);
      vendor.filename = implPath;
      vendor.paths = Module._nodeModulePaths(require('node:path').dirname(implPath));
      vendor._compile(readFileSync(implPath, 'utf8') + '\\nexports.normalizeOptionsForTest = normalizeOptions;', implPath);
      process.stdout.write(JSON.stringify({
        valid: cases.map(options => {
          try { validateOptsAgainstSchema(options, schema); return true; } catch { return false; }
        }),
        normalized: cases.filter(options => Array.isArray(options.command) && options.command.every(value => typeof value === 'string')).map(options => vendor.exports.normalizeOptionsForTest({ command: options.command, __unparsed__: [], forwardAllArgs: false }).commands.map(entry => entry.command))
      }));
    `,
      ],
      {
        cwd: process.cwd(),
        stdin: new TextEncoder().encode(
          JSON.stringify(cases.map((entry) => entry.options))
        ),
      }
    );
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({
      normalized: cases
        .filter((entry) => Array.isArray(entry.options.command) && entry.valid)
        .map((entry) => entry.proof),
      valid: cases.map((entry) => entry.valid),
    });
  });

  test("rejects every malformed field before granting any base or configuration literal proof", () => {
    for (const entry of cases) {
      for (const command of [HARNESS, CARGO]) {
        const options = withCommand(entry.options, command);
        const expected = entry.proof.map((literal) =>
          literal.replaceAll(HARNESS, command)
        );
        const targets: NxProjectTarget[] = [
          { executor: RUN, options },
          {
            configurations: { native: options },
            defaultConfiguration: "native",
            executor: RUN,
          },
          {
            configurations: { alternate: options },
            executor: RUN,
            options: {},
          },
          {
            configurations: { native: options },
            defaultConfiguration: "native",
            executor: RUN,
            options: {},
          },
        ];
        for (const target of targets) {
          if (!entry.valid && entry.name !== "commandless fragment") {
            expect(() => targetCommandStrings(target), entry.name).toThrow(
              TypeError
            );
            expect(() => targetCommandStrings(target), entry.name).toThrow(
              "invalid nx:run-commands"
            );
          } else {
            expect(targetCommandStrings(target), entry.name).toEqual(expected);
          }
        }
        if (!entry.valid && entry.name !== "commandless fragment") {
          for (const configurations of [
            Object.fromEntries([
              ["bad", options],
              ["valid", { command }],
            ]),
            Object.fromEntries([
              ["valid", { command }],
              ["bad", options],
            ]),
          ]) {
            expect(
              () =>
                targetCommandStrings({
                  configurations,
                  defaultConfiguration: "valid",
                  executor: RUN,
                }),
              entry.name
            ).toThrow("invalid nx:run-commands");
          }
          expect(
            () =>
              targetCommandStrings({
                configurations: {
                  repaired: { command, env: {}, parallel: true },
                },
                executor: RUN,
                options,
              }),
            entry.name
          ).toThrow("invalid nx:run-commands");
        }
      }
    }
  });

  test("strict native discovery gives all invalid known fields no selected-default credit", () => {
    const command = "bunx --bun oxlint --type-aware typescript/kernel/protocol";
    for (const entry of cases.filter((candidate) => !candidate.valid)) {
      const options = withCommand(entry.options, command);
      for (const target of [
        { executor: RUN, options },
        {
          configurations: { native: options },
          defaultConfiguration: "native",
          executor: RUN,
          options: {},
        },
      ]) {
        expect(
          discoverNativeLintProjects([
            {
              name: "fixture",
              path: "typescript/kernel/protocol/project.json",
              project: { targets: { lint: target } },
            },
          ]),
          entry.name
        ).toEqual({ jsonOnlyProjects: [], oxcProjects: [] });
      }
    }
  });

  test("preserves partial fragments, shallow merging, literal order and default selection independence", () => {
    for (const command of [HARNESS, CARGO]) {
      const alternate = `${command} --alternate`;
      const scenarios: {
        target: NxProjectTarget;
        expected: string[];
        invalid?: boolean;
      }[] = [
        {
          expected: [command],
          target: {
            configurations: { native: { command } },
            options: { env: { A: "1" } },
          },
        },
        {
          expected: [command],
          target: {
            configurations: {
              empty: {},
              fragment: { parallel: false },
              native: { command },
            },
          },
        },
        {
          expected: [],
          invalid: true,
          target: {
            configurations: {
              first: { args: "a" },
              second: { command: alternate },
            },
            options: { commands: [command, { command: alternate }] },
          },
        },
        {
          expected: [command, alternate, alternate, command],
          target: {
            configurations: {
              first: { args: "a" },
              second: { commands: [alternate, command] },
            },
            options: { commands: [command, { command: alternate }] },
          },
        },
        {
          expected: [command, alternate],
          target: {
            configurations: {
              alternate: { command: alternate },
              native: { env: { C: "3" } },
            },
            options: { command, env: { A: "1", B: "2" } },
          },
        },
        {
          expected: [],
          invalid: true,
          target: {
            configurations: { native: { parallel: true } },
            options: { command, parallel: "invalid" },
          },
        },
        {
          expected: [],
          invalid: true,
          target: {
            configurations: { native: { commands: [] } },
            options: { command },
          },
        },
        {
          expected: [],
          invalid: true,
          target: {
            configurations: { native: { command: alternate } },
            options: { commands: [command] },
          },
        },
        {
          expected: [command, alternate],
          target: {
            configurations: { native: { command: alternate } },
            options: { command: [command] },
          },
        },
        {
          expected: [command, alternate],
          target: {
            configurations: { native: { command: [alternate] } },
            options: { command },
          },
        },
      ];
      for (const { target, expected, invalid } of scenarios) {
        for (const defaultConfiguration of [
          undefined,
          "native",
          "alternate",
          "missing",
          "",
        ]) {
          const inventory = () =>
            targetCommandStrings({
              ...target,
              executor: RUN,
              ...(defaultConfiguration === undefined
                ? {}
                : { defaultConfiguration }),
            });
          if (invalid === true) {
            expect(inventory).toThrow("invalid nx:run-commands");
          } else {
            expect(inventory()).toEqual(expected);
          }
        }
      }
      expect(
        targetCommandStrings({
          configurations: { "": { command: alternate }, native: {} },
          defaultConfiguration: "",
          executor: RUN,
          options: { command },
        })
      ).toEqual([command, alternate]);
    }
  });

  test("strict native selection ignores invalid inactive siblings and validates the shallow effective record", () => {
    const command = "bunx --bun oxlint --type-aware typescript/kernel/protocol";
    const credited = {
      jsonOnlyProjects: [],
      oxcProjects: [
        {
          jsonCompanion: false,
          name: "fixture",
          root: "typescript/kernel/protocol",
        },
      ],
    };
    for (const defaultConfiguration of [undefined, "missing", "", "native"]) {
      expect(
        discover({
          configurations: { bad: { parallel: "invalid" }, native: {} },
          options: { command },
          ...(defaultConfiguration === undefined
            ? {}
            : { defaultConfiguration }),
        })
      ).toEqual(credited);
    }
    expect(
      discover({
        configurations: { native: { parallel: false } },
        defaultConfiguration: "native",
        options: { command, parallel: "invalid" },
      })
    ).toEqual({ jsonOnlyProjects: [], oxcProjects: [] });
    expect(
      discover({
        configurations: { native: { command } },
        defaultConfiguration: "native",
        options: { command: "bun biome.ts", env: false },
      })
    ).toEqual({ jsonOnlyProjects: [], oxcProjects: [] });
  });
});
