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
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  findConformancePlans,
  loadConformancePlan,
} from "../../conformance/plan-compiler/index.ts";
import {
  assertCertificationSchemaContracts,
  PINNED_AUTHORITY_PACKET_REFERENCES,
  PINNED_CERTIFICATION_EVIDENCE,
  PINNED_CERTIFICATION_PROFILES,
  PINNED_CONFORMANCE_PLAN,
  PINNED_NEGATIVE_CONTROLS,
  PINNED_OBSERVATION_RECORD,
  PINNED_OPERATION_CATALOG,
} from "./certification-schema-examples.ts";
import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "./certification-schemas.ts";
import type { CertificationSchemaName } from "./certification-schemas.ts";
import {
  ObservationEncodingError,
  parseObservationJson,
} from "./observation-encoding.ts";

const REPO_ROOT = nodePath.resolve(import.meta.dirname, "../../..");

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

const at = (value: unknown, ...path: (number | string)[]): Json => {
  let current: unknown = value;

  for (const segment of path) {
    current = (current as Record<number | string, unknown>)[segment];
  }

  return current as Json;
};

const remove = (record: Json, key: string): void => {
  Reflect.deleteProperty(record, key);
};

const expectValid = (name: CertificationSchemaName, value: unknown): void => {
  expect(validateCertificationDocument(name, value)).toEqual([]);
};

const expectInvalid = (name: CertificationSchemaName, value: unknown): void => {
  expect(validateCertificationDocument(name, value).length).toBeGreaterThan(0);
};

const mutated = <T>(value: T, mutate: (draft: T) => void): T => {
  const draft = clone(value);
  mutate(draft);
  return draft;
};

const readJson = async (relativePath: string): Promise<unknown> =>
  JSON.parse(
    await readFile(nodePath.resolve(REPO_ROOT, relativePath), "utf-8")
  );

const plan = PINNED_CONFORMANCE_PLAN;
const stepOf = (draft: typeof plan, stepId: string): Json => {
  const step = at(draft, "checks", 0, "steps") as unknown as Json[];
  const found = step.find((entry) => entry.stepId === stepId);

  if (found === undefined) {
    throw new Error(`pinned plan has no step ${stepId}`);
  }

  return found;
};

describe("pinned certification examples", () => {
  test("validate and reject undeclared root fields", () => {
    expect(() => {
      assertCertificationSchemaContracts();
    }).not.toThrow();
  });
});

describe("operation catalog schema", () => {
  test("accepts the pinned catalog", () => {
    expectValid("operationCatalog", PINNED_OPERATION_CATALOG);
    expect(
      collectCertificationIntegrityFailures(
        "operationCatalog",
        PINNED_OPERATION_CATALOG
      )
    ).toEqual([]);
  });

  test.each([
    ["root", []],
    ["operation", ["operations", 0]],
    ["observation", ["operations", 0, "observation"]],
    ["handles", ["operations", 0, "handles"]],
    ["seam", ["seams", 0]],
  ] as const)("rejects an undeclared %s field", (_label, path) => {
    expectInvalid(
      "operationCatalog",
      mutated(PINNED_OPERATION_CATALOG, (draft) => {
        at(draft, ...path).verdict = true;
      })
    );
  });

  test("rejects an open result observation schema", () => {
    expectInvalid(
      "operationCatalog",
      mutated(PINNED_OPERATION_CATALOG, (draft) => {
        remove(
          at(draft, "operations", 0, "observation", "result"),
          "additionalProperties"
        );
      })
    );
    expectInvalid(
      "operationCatalog",
      mutated(PINNED_OPERATION_CATALOG, (draft) => {
        at(draft, "operations", 0, "observation").state = true;
      })
    );
  });

  test("requires a binding on syscalls only", () => {
    expectInvalid(
      "operationCatalog",
      mutated(PINNED_OPERATION_CATALOG, (draft) => {
        remove(at(draft, "operations", 0), "binding");
      })
    );
    expect(
      at(PINNED_OPERATION_CATALOG, "operations", 2).binding
    ).toBeUndefined();
  });

  test("rejects unknown kinds, handle types, versions, and input schemas", () => {
    for (const mutate of [
      (draft: Json) => {
        at(draft, "operations", 0).kind = "scenario";
      },
      (draft: Json) => {
        at(draft, "operations", 0, "handles").consumes = ["fixture"];
      },
      (draft: Json) => {
        draft.catalogVersion = "1";
      },
      (draft: Json) => {
        at(draft, "operations", 0).input = { type: 7 };
      },
      (draft: Json) => {
        at(draft, "operations", 0).operationId = "put";
      },
    ]) {
      expectInvalid(
        "operationCatalog",
        mutated(PINNED_OPERATION_CATALOG as Json, mutate)
      );
    }
  });

  test.each([
    ["an open object inside anyOf", { anyOf: [{ type: "object" }] }],
    [
      "an open object inside a closed object",
      {
        additionalProperties: false,
        properties: { inner: { type: "object" } },
        type: "object",
      },
    ],
    ["an array of open objects", { items: { type: "object" }, type: "array" }],
    [
      "an open object in prefixItems",
      { items: false, prefixItems: [{ type: "object" }], type: "array" },
    ],
    [
      "an open object behind a local $ref",
      { $defs: { open: { type: "object" } }, $ref: "#/$defs/open" },
    ],
    [
      "an open object in an additionalProperties schema",
      {
        additionalProperties: { type: "object" },
        type: "object",
        unevaluatedProperties: false,
      },
    ],
    [
      "an open object in a oneOf branch of allOf",
      { allOf: [{ oneOf: [{ type: "string" }, { properties: {} }] }] },
    ],
    [
      "an empty property schema",
      {
        additionalProperties: false,
        properties: { payload: {} },
        type: "object",
      },
    ],
    [
      "a true property schema",
      {
        additionalProperties: false,
        properties: { payload: true },
        type: "object",
      },
    ],
    [
      "a type-less property schema",
      {
        additionalProperties: false,
        properties: { payload: { description: "anything", minLength: 1 } },
        type: "object",
      },
    ],
    ["an array of anything", { items: true, type: "array" }],
    ["an array without items", { type: "array" }],
  ])("reports %s reachable from an observation schema", (_label, schema) => {
    const catalog = mutated(PINNED_OPERATION_CATALOG, (draft) => {
      at(draft, "operations", 1, "observation").result = schema;
    });

    expect(
      collectCertificationIntegrityFailures("operationCatalog", catalog)
    ).toEqual([expect.stringContaining("kernel.tree.diff observation.result")]);
  });

  test("accepts nested closed objects and the encoding record union", () => {
    const catalog = mutated(PINNED_OPERATION_CATALOG, (draft) => {
      at(draft, "operations", 1, "observation").result = {
        $defs: {
          entry: {
            additionalProperties: false,
            properties: { key: { type: "string" } },
            type: "object",
          },
        },
        additionalProperties: false,
        properties: {
          entries: { items: { $ref: "#/$defs/entry" }, type: "array" },
          record: {
            $ref: "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json#/$defs/record",
          },
          tagged: {
            anyOf: [
              { additionalProperties: false, type: "object" },
              { type: "string" },
            ],
          },
        },
        type: "object",
      };
    });

    expectValid("operationCatalog", catalog);
    expect(
      collectCertificationIntegrityFailures("operationCatalog", catalog)
    ).toEqual([]);
  });

  test("accepts property schemas that exclude objects", () => {
    const catalog = mutated(PINNED_OPERATION_CATALOG, (draft) => {
      at(draft, "operations", 1, "observation").result = {
        additionalProperties: false,
        properties: {
          constant: { const: 1 },
          enumerated: { enum: ["a", 1, null] },
          never: false,
          nullable: { type: ["string", "null"] },
          text: { type: "string" },
        },
        type: "object",
      };
    });

    expect(
      collectCertificationIntegrityFailures("operationCatalog", catalog)
    ).toEqual([]);
  });

  test("reports an observation $ref it cannot resolve", () => {
    const catalog = mutated(PINNED_OPERATION_CATALOG, (draft) => {
      at(draft, "operations", 1, "observation").result = {
        $ref: "https://example.com/open.json",
      };
    });

    expect(
      collectCertificationIntegrityFailures("operationCatalog", catalog)
    ).toEqual([expect.stringContaining("kernel.tree.diff observation.result")]);
  });

  describe("observation schema dialect", () => {
    const ENCODING_ID =
      "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json";
    const failuresFor = (schema: unknown): readonly string[] =>
      collectCertificationIntegrityFailures(
        "operationCatalog",
        mutated(PINNED_OPERATION_CATALOG, (draft) => {
          at(draft, "operations", 1, "observation").result = schema;
        })
      );
    const closedWith = (properties: Json): Json => ({
      additionalProperties: false,
      properties,
      type: "object",
    });

    test.each([
      [
        "a type-less closed payload that admits arrays of open objects",
        closedWith({ payload: { additionalProperties: false } }),
        "/properties/payload",
      ],
      ["true", closedWith({ payload: true }), "/properties/payload"],
      ["{}", closedWith({ payload: {} }), "/properties/payload"],
      [
        "a type-less schema",
        closedWith({ payload: { minLength: 1 } }),
        "/properties/payload",
      ],
      [
        "allOf",
        closedWith({
          payload: {
            allOf: [{ items: { type: "string" }, type: "array" }],
            type: "array",
          },
        }),
        "/properties/payload",
      ],
      [
        "not",
        closedWith({ payload: { not: { type: "object" }, type: "string" } }),
        "/properties/payload",
      ],
      [
        "if/then/else",
        closedWith({
          payload: JSON.parse(
            '{"if":{"type":"string"},"then":{"type":"string"},"else":{"type":"string"},"type":"string"}'
          ),
        }),
        "/properties/payload",
      ],
      [
        "dependentSchemas",
        {
          additionalProperties: false,
          dependentSchemas: { a: { type: "object" } },
          type: "object",
        },
        "",
      ],
      [
        "$dynamicRef",
        closedWith({ payload: { $dynamicRef: "#node" } }),
        "/properties/payload",
      ],
      [
        "an encoding $ref outside the dialect definitions",
        closedWith({ payload: { $ref: `${ENCODING_ID}#/$defs/mapEntry` } }),
        "/properties/payload",
      ],
      [
        "a local $ref outside $defs",
        closedWith({ payload: { $ref: "#/properties/other" } }),
        "/properties/payload",
      ],
      [
        "a closed object in an open object",
        closedWith({
          payload: {
            properties: { inner: { type: "string" } },
            type: "object",
          },
        }),
        "/properties/payload",
      ],
      [
        "an array without a direct items schema",
        closedWith({
          payload: { prefixItems: [{ type: "string" }], type: "array" },
        }),
        "/properties/payload",
      ],
      [
        "an open object behind a local $ref",
        {
          $defs: { open: { type: "object" } },
          $ref: "#/$defs/open",
        },
        "/$defs/open",
      ],
    ])(
      "rejects %s with the dialect rule and pointer",
      (_label, schema, pointer) => {
        expect(failuresFor(schema)).toEqual([
          expect.stringContaining(
            `kernel.tree.diff observation.result#${pointer} `
          ),
        ]);
        expect(failuresFor(schema)[0]).toContain(
          "use the certification observation dialect"
        );
      }
    );

    test("accepts an array of closed objects", () => {
      expect(
        failuresFor(
          closedWith({
            payload: {
              items: {
                additionalProperties: false,
                properties: {},
                type: "object",
              },
              type: "array",
            },
          })
        )
      ).toEqual([]);
    });

    test("accepts local $defs and every encoding definition", () => {
      expect(
        failuresFor({
          $defs: {
            entry: closedWith({ key: { $ref: "#/$defs/key" } }),
            key: { type: "string" },
          },
          ...closedWith({
            entries: { items: { $ref: "#/$defs/entry" }, type: "array" },
            ...Object.fromEntries(
              [
                "bytes",
                "safeInteger",
                "hash",
                "identifier",
                "handle",
                "record",
                "map",
              ].map((name) => [name, { $ref: `${ENCODING_ID}#/$defs/${name}` }])
            ),
          }),
        })
      ).toEqual([]);
    });

    test("accepts anyOf and oneOf of typed branches, const, and enum", () => {
      expect(
        failuresFor(
          closedWith({
            either: {
              oneOf: [{ type: "null" }, { $ref: `${ENCODING_ID}#/$defs/hash` }],
            },
            kind: { const: "turn" },
            mode: { enum: ["a", "b"] },
            tagged: {
              anyOf: [
                closedWith({ tag: { const: "a" } }),
                { items: { type: "string" }, type: ["array", "null"] },
              ],
            },
          })
        )
      ).toEqual([]);
    });

    test("terminates on recursive and self-referencing $defs", () => {
      expect(
        failuresFor({
          $defs: {
            tree: closedWith({
              children: { items: { $ref: "#/$defs/tree" }, type: "array" },
            }),
          },
          $ref: "#/$defs/tree",
        })
      ).toEqual([]);
      expect(
        failuresFor({
          $defs: { loop: { anyOf: [{ $ref: "#/$defs/loop" }] } },
          $ref: "#/$defs/loop",
        })
      ).toEqual([
        expect.stringContaining(
          "kernel.tree.diff observation.result#/$defs/loop/anyOf/0 "
        ),
      ]);
    });
  });

  test("reports duplicate operation ids and seams naming uncatalogued operations", () => {
    const catalog = mutated(PINNED_OPERATION_CATALOG, (draft) => {
      draft.operations.push(clone(at(draft, "operations", 0)) as never);
      at(draft, "seams", 0).operationIds = ["kernel.missing"];
    });

    expect(
      collectCertificationIntegrityFailures("operationCatalog", catalog)
    ).toEqual([
      "duplicate operationId kernel.store.put",
      "seam kernel.head.compare-and-set names uncatalogued operation kernel.missing",
    ]);
  });
});

describe("observation encoding schema", () => {
  test("accepts the pinned tagged record", () => {
    expectValid("observationEncoding", PINNED_OBSERVATION_RECORD);
  });

  test.each([
    ["uppercase hex", { $bytes: "00FF" }],
    ["odd-length hex", { $bytes: "0" }],
    ["non-hex", { $bytes: "zz" }],
    ["extra key on $bytes", { $bytes: "00", length: 1 }],
    ["fraction", 1.5],
    ["unsafe integer", 2 ** 53],
    ["unsafe negative integer", -(2 ** 53)],
    ["untagged object", { kind: "turn-node" }],
    ["short $map entry", { $map: [["key"]] }],
    ["long $map entry", { $map: [["key", 1, 2]] }],
    ["non-array $map", { $map: { key: 1 } }],
    ["nested float", [1, 2.5]],
  ])("rejects %s", (_label, value) => {
    expectInvalid("observationEncoding", value);
  });

  test("decodes the pinned record losslessly", () => {
    expect(
      parseObservationJson(JSON.stringify(PINNED_OBSERVATION_RECORD))
    ).toEqual(PINNED_OBSERVATION_RECORD);
  });

  test.each([
    ["duplicate object keys", '{"a":1,"a":2}'],
    ["escaped duplicate object keys", '{"a":1,"\\u0061":2}'],
    ["duplicate $map keys", '{"$map":[["a",1],["a",2]]}'],
    [
      "duplicate structured $map keys",
      '{"$map":[[{"$bytes":"00"},1],[{"$bytes":"00"},2]]}',
    ],
    ["negative zero", '{"n":-0}'],
    ["negative zero fraction", "[-0.0]"],
    ["overflowing number", "1e400"],
    ["trailing text", "{} {}"],
    ["single-quoted string", "'a'"],
    ["raw control character in a string", '"a\u0001b"'],
    ["invalid escape", '"\\x41"'],
    ["fraction that rounds to an integer", "1.00000000000000001"],
    ["fraction below 2^53 that rounds to an integer", "9007199254740990.5"],
    ["exponent that underflows to zero", "1e-400"],
    [
      "nested fraction that rounds to an integer",
      '{"$map":[["n",1.0000000000000000001]]}',
    ],
  ])("decoder rejects %s", (_label, text) => {
    expect(() => parseObservationJson(text)).toThrow(ObservationEncodingError);
  });

  test.each([
    ["1.0", 1],
    ["1e2", 100],
    ["10e-1", 1],
    ["1.5e1", 15],
    ["0e-400", 0],
    ["9007199254740991.000", 9_007_199_254_740_991],
  ])("decoder keeps the exact integer token %s", (text, expected) => {
    const value = parseObservationJson(text);

    expect(value).toBe(expected);
    expectValid("observationEncoding", value);
  });

  test.each([
    ["2.5", 2.5],
    ["0.1", 0.1],
    ["1e-300", 1e-300],
    ["-1.25e-2", -0.0125],
  ])(
    "decoder keeps the finite non-integer %s for float fields",
    (text, expected) => {
      const value = parseObservationJson(text);

      expect(value).toBe(expected);
      expectInvalid("observationEncoding", value);
    }
  );

  test("decoder keeps __proto__ as an ordinary key", () => {
    const value = parseObservationJson('{"__proto__":{"polluted":true}}');

    expect(Object.keys(value as object)).toEqual(["__proto__"]);
    expect(({} as Json).polluted).toBeUndefined();
  });
});

describe("conformance plan schema", () => {
  test("accepts the pinned plan extensions", () => {
    expectValid("conformancePlan", PINNED_CONFORMANCE_PLAN);
  });

  test("keeps every checked-in plan valid", async () => {
    const planPaths = await findConformancePlans();

    expect(planPaths.length).toBeGreaterThan(0);
    await Promise.all(
      planPaths.map(async (planPath) => {
        expectValid("conformancePlan", await readJson(planPath));
        await loadConformancePlan(planPath);
      })
    );
  });

  test("compiles a plan that uses the new step fields", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "tuvren-cz-plan-"));
    await mkdir(nodePath.join(directory, "fixtures"));
    await writeFile(
      nodePath.join(directory, "fixtures/race.json"),
      JSON.stringify({ input: { payloads: [1, 2] } })
    );
    const planPath = nodePath.join(directory, "plans/plan.json");
    await mkdir(nodePath.dirname(planPath));
    await writeFile(planPath, JSON.stringify(PINNED_CONFORMANCE_PLAN));

    const compiled = await loadConformancePlan(planPath);

    expect(compiled.plan.checks[0]?.claimIds).toEqual([
      "kernel.head.single-winner",
    ]);
    expect(compiled.plan.checks[0]?.steps?.[3]?.action).toBe("start");
  });

  test.each([
    ["top-level", { head: { $ref: "fixture.expected.head" } }],
    ["nested object", { nested: { head: { $ref: "fixture.expected.head" } } }],
    ["nested array", { heads: ["main", { $ref: "fixture.expected.heads.0" }] }],
    ["bare expected root", { head: { $ref: "fixture.expected" } }],
  ])(
    "rejects a fixture.expected reference in arguments (%s)",
    (_label, args) => {
      expectInvalid(
        "conformancePlan",
        mutated(plan, (draft) => {
          stepOf(draft, "start-a").arguments = args;
        })
      );
    }
  );

  test.each([
    "scenario.payload",
    "fixture.payload",
    "fixture",
    "trace.start-a.result",
    "input",
    "capture",
    "input..branchId",
    "$.input.branchId",
  ])("rejects the argument reference %s", (reference) => {
    expectInvalid(
      "conformancePlan",
      mutated(plan, (draft) => {
        stepOf(draft, "start-a").arguments = { value: { $ref: reference } };
      })
    );
  });

  test("rejects references and literals that carry extra keys", () => {
    for (const value of [
      { $ref: "input.branchId", fallback: "main" },
      { $literal: 1, note: "x" },
    ]) {
      expectInvalid(
        "conformancePlan",
        mutated(plan, (draft) => {
          stepOf(draft, "start-a").arguments = { value };
        })
      );
    }
  });

  test.each([
    [
      "undeclared step field",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").scenario = "race";
      },
    ],
    [
      "undeclared check field",
      (draft: typeof plan) => {
        at(draft, "checks", 0).obligations = [];
      },
    ],
    [
      "undeclared capture field",
      (draft: typeof plan) => {
        at(stepOf(draft, "start-a"), "capture", 0).from = "result";
      },
    ],
    [
      "capture path outside the observation",
      (draft: typeof plan) => {
        at(stepOf(draft, "start-a"), "capture", 0).path =
          "fixture.expected.head";
      },
    ],
    [
      "capture name containing a dot",
      (draft: typeof plan) => {
        at(stepOf(draft, "start-a"), "capture", 0).name = "op.a";
      },
    ],
    [
      "barrier without a seam",
      (draft: typeof plan) => {
        remove(stepOf(draft, "gate"), "seam");
      },
    ],
    [
      "barrier without participants",
      (draft: typeof plan) => {
        remove(stepOf(draft, "gate"), "participants");
      },
    ],
    [
      "release without a barrier id",
      (draft: typeof plan) => {
        remove(stepOf(draft, "release"), "barrierId");
      },
    ],
    [
      "release naming a seam",
      (draft: typeof plan) => {
        stepOf(draft, "release").seam = "kernel.head.compare-and-set";
      },
    ],
    [
      "seam on a start step",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").seam = "kernel.head.compare-and-set";
      },
    ],
    [
      "participants on a step without an action",
      (draft: typeof plan) => {
        const step = stepOf(draft, "recover");
        remove(step, "action");
        step.participants = ["start-a"];
      },
    ],
    [
      "input beside arguments",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").input = { branchId: "main" };
      },
    ],
    [
      "unknown action",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").action = "teleport";
      },
    ],
    [
      "non-object arguments",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").arguments = ["main"];
      },
    ],
    [
      "empty claim ids",
      (draft: typeof plan) => {
        at(draft, "checks", 0).claimIds = [];
      },
    ],
    [
      "duplicate claim ids",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").claimIds = ["a", "a"];
      },
    ],
    [
      "non-integer deadline",
      (draft: typeof plan) => {
        stepOf(draft, "start-a").controls = { deadlineMs: 1.5 };
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    expectInvalid("conformancePlan", mutated(plan, mutate));
  });

  test("accepts a $literal that looks like a reference", () => {
    expectValid(
      "conformancePlan",
      mutated(plan, (draft) => {
        stepOf(draft, "start-a").arguments = {
          value: { $literal: { $ref: "fixture.expected.head" } },
        };
      })
    );
  });
});

describe("authority packet schema", () => {
  const packetPaths = async (): Promise<string[]> => {
    const entries = await readdir(nodePath.join(REPO_ROOT, "spec"), {
      recursive: true,
    });
    return entries
      .filter((entry) => entry.endsWith("authority-packet.json"))
      .map((entry) => `spec/${entry}`);
  };

  test("keeps every checked-in packet valid and accepts certification references", async () => {
    const paths = await packetPaths();

    expect(paths.length).toBeGreaterThan(0);
    await Promise.all(
      paths.map(async (packetPath) => {
        const packet = (await readJson(packetPath)) as Json;
        expectValid("authorityPacket", packet);
        expectValid("authorityPacket", {
          ...packet,
          ...PINNED_AUTHORITY_PACKET_REFERENCES,
        });
      })
    );
  });

  test("rejects undeclared and empty certification references", async () => {
    const packet = (await readJson(
      "spec/kernel/authority-packet.json"
    )) as Json;

    expectInvalid("authorityPacket", { ...packet, identityRecipeSet: "x" });
    expectInvalid("authorityPacket", { ...packet, operationCatalog: "" });
  });
});

describe("certification profile schema", () => {
  test("accepts the pinned profiles", () => {
    expectValid("certificationProfile", PINNED_CERTIFICATION_PROFILES);
  });

  test.each([
    [
      "undeclared profile field",
      (draft: Json) => {
        at(draft, "profiles", 0).optionalChecks = [];
      },
    ],
    [
      "missing claim ids",
      (draft: Json) => {
        remove(at(draft, "profiles", 0), "claimIds");
      },
    ],
    [
      "missing required evidence",
      (draft: Json) => {
        remove(at(draft, "profiles", 1), "requiredEvidence");
      },
    ],
    [
      "empty required capabilities",
      (draft: Json) => {
        at(draft, "profiles", 0).requiredCapabilities = [];
      },
    ],
    [
      "duplicate fault points",
      (draft: Json) => {
        at(draft, "profiles", 1).faultPoints = ["a", "a"];
      },
    ],
    [
      "malformed profile id",
      (draft: Json) => {
        at(draft, "profiles", 0).profileId = "Kernel Memory";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    expectInvalid(
      "certificationProfile",
      mutated(PINNED_CERTIFICATION_PROFILES as Json, mutate)
    );
  });

  test("reports duplicate profile ids", () => {
    const profiles = mutated(PINNED_CERTIFICATION_PROFILES, (draft) => {
      draft.profiles.push(clone(at(draft, "profiles", 0)) as never);
    });

    expect(
      collectCertificationIntegrityFailures("certificationProfile", profiles)
    ).toEqual(["duplicate profileId kernel.memory"]);
  });
});

describe("negative-control manifest schema", () => {
  test("accepts the pinned controls of every kind", () => {
    expectValid("negativeControlManifest", PINNED_NEGATIVE_CONTROLS);
  });

  test.each([
    [
      "undeclared control field",
      (draft: Json) => {
        at(draft, "controls", 0).mustFail = [];
      },
    ],
    [
      "undeclared activation field",
      (draft: Json) => {
        at(draft, "controls", 0, "activation").faultToken = "x";
      },
    ],
    [
      "implementation control without designated assertions",
      (draft: Json) => {
        remove(at(draft, "controls", 0), "designatedAssertions");
      },
    ],
    [
      "implementation control with an expected rejection",
      (draft: Json) => {
        at(draft, "controls", 0).expectedRejection =
          "observation_schema_violation";
      },
    ],
    [
      "observation control without an expected rejection",
      (draft: Json) => {
        remove(at(draft, "controls", 1), "expectedRejection");
      },
    ],
    [
      "instrumentation control with designated assertions",
      (draft: Json) => {
        at(draft, "controls", 2).designatedAssertions = ["a"];
      },
    ],
    [
      "unknown kind",
      (draft: Json) => {
        at(draft, "controls", 0).kind = "fake-adapter";
      },
    ],
    [
      "missing activation",
      (draft: Json) => {
        remove(at(draft, "controls", 0), "activation");
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    expectInvalid(
      "negativeControlManifest",
      mutated(PINNED_NEGATIVE_CONTROLS as Json, mutate)
    );
  });

  test("reports duplicate mutant ids", () => {
    const controls = mutated(PINNED_NEGATIVE_CONTROLS, (draft) => {
      draft.controls.push(clone(at(draft, "controls", 0)) as never);
    });

    expect(
      collectCertificationIntegrityFailures("negativeControlManifest", controls)
    ).toEqual(["duplicate mutantId kernel.accept-stale-head"]);
  });
});

describe("certification evidence schema", () => {
  test("accepts the pinned certificate and failure artifact", () => {
    expectValid("certificationEvidence", PINNED_CERTIFICATION_EVIDENCE);
  });

  test("keeps every checked-in harness evidence file valid", async () => {
    const directory = "reports/compatibility/evidence";
    const files = (await readdir(nodePath.join(REPO_ROOT, directory))).filter(
      (file) => file.startsWith("certification-harness.")
    );

    expect(files.length).toBeGreaterThan(0);
    await Promise.all(
      files.map(async (file) => {
        expectValid(
          "certificationEvidence",
          await readJson(`${directory}/${file}`)
        );
      })
    );
  });

  test.each([
    [
      "undeclared root field",
      (draft: Json) => {
        draft.verdict = "pass";
      },
    ],
    [
      "undeclared certificate field",
      (draft: Json) => {
        at(draft, "certificate").scope = "all";
      },
    ],
    [
      "certificate without completeness",
      (draft: Json) => {
        remove(at(draft, "certificate"), "complete");
      },
    ],
    [
      "unknown certificate status",
      (draft: Json) => {
        at(draft, "certificate").status = "pending";
      },
    ],
    [
      "undeclared digest",
      (draft: Json) => {
        at(draft, "digests").adapterSource = "a".repeat(64);
      },
    ],
    [
      "missing verifier authority digest",
      (draft: Json) => {
        remove(at(draft, "digests"), "verifierAuthority");
      },
    ],
    [
      "non-hash digest",
      (draft: Json) => {
        at(draft, "digests").plans = "A".repeat(64);
      },
    ],
    [
      "exclusion without a reason",
      (draft: Json) => {
        remove(at(draft, "selection", 2), "reason");
      },
    ],
    [
      "undeclared selection field",
      (draft: Json) => {
        at(draft, "selection", 0).shard = 1;
      },
    ],
    [
      "undeclared failure field",
      (draft: Json) => {
        at(draft, "checkResults", 1, "failure").verdict = "fail";
      },
    ],
    [
      "undeclared operand field",
      (draft: Json) => {
        at(draft, "checkResults", 1, "failure", "operands", 0).equal = true;
      },
    ],
    [
      "unknown classification",
      (draft: Json) => {
        at(draft, "checkResults", 1, "failure").classification =
          "specification_gap";
      },
    ],
    [
      "failure on a passing check",
      (draft: Json) => {
        at(draft, "checkResults", 0).failure = at(
          draft,
          "checkResults",
          1
        ).failure;
      },
    ],
    [
      "undeclared check result field",
      (draft: Json) => {
        at(draft, "checkResults", 0).score = 1;
      },
    ],
    [
      "undeclared assertion result field",
      (draft: Json) => {
        at(draft, "checkResults", 0, "assertionResults", 0).weight = 1;
      },
    ],
    [
      "non-integer summary count",
      (draft: Json) => {
        at(draft, "summary").totalChecks = 3.5;
      },
    ],
    [
      "unknown run status",
      (draft: Json) => {
        draft.status = "partial";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    expectInvalid(
      "certificationEvidence",
      mutated(PINNED_CERTIFICATION_EVIDENCE as Json, mutate)
    );
  });

  test.each(["digests", "negativeControlRunId", "environment", "selection"])(
    "rejects a certified certificate without %s",
    (key) => {
      expectInvalid(
        "certificationEvidence",
        mutated(PINNED_CERTIFICATION_EVIDENCE as Json, (draft) => {
          remove(draft, key);
        })
      );
    }
  );

  test("rejects a certified certificate from an incomplete run", () => {
    expectInvalid(
      "certificationEvidence",
      mutated(PINNED_CERTIFICATION_EVIDENCE as Json, (draft) => {
        at(draft, "certificate").complete = false;
      })
    );
  });

  test("accepts an uncertified certificate without certification fields", () => {
    expectValid(
      "certificationEvidence",
      mutated(PINNED_CERTIFICATION_EVIDENCE as Json, (draft) => {
        at(draft, "certificate").status = "uncertified";
        at(draft, "certificate").complete = false;
        for (const key of [
          "digests",
          "negativeControlRunId",
          "environment",
          "selection",
        ]) {
          remove(draft, key);
        }
      })
    );
  });

  test("accepts legacy evidence without a certificate", () => {
    expectValid(
      "certificationEvidence",
      mutated(PINNED_CERTIFICATION_EVIDENCE as Json, (draft) => {
        for (const key of [
          "certificate",
          "digests",
          "negativeControlRunId",
          "environment",
          "selection",
        ]) {
          remove(draft, key);
        }
      })
    );
  });
});
