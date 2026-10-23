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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { assertKernelRecord } from "@tuvren/core";
import Ajv2020 from "ajv/dist/2020.js";
import ts from "typescript";

import {
  collectCertificationIntegrityFailures,
  validateCertificationDocument,
} from "../../../../tools/scripts/conformance/certification-schemas.ts";
import {
  assertTurnTreeManifest,
  assertTurnTreeSchema,
  encodeDeterministicKernelRecord,
  hashTurnTreeIdentity,
} from "../src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, file), "utf-8"));
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new Error("expected an object");
  }
  return value;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError("expected an array");
  }
  return value;
};
const string = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("expected a string");
  }
  return value;
};
const readIdentityFixture = (name: string): Record<string, unknown> =>
  object(
    readJson(`spec/conformance/kernel/fixtures/kernel-protocol-${name}.json`)
  );
const nodePayload = (fixture: Record<string, unknown>): unknown =>
  object(array(object(fixture.turnNodeIdentityRecord).consumedStagedResults)[0])
    .interruptPayload;
const catalog = (): Record<string, unknown> =>
  object(readJson("spec/conformance/kernel/operations.json"));
const operations = (): Record<string, unknown>[] =>
  array(catalog().operations).map(object);
const packet = object(readJson("spec/kernel/authority-packet.json"));
const planDirectory = "spec/conformance/kernel/plans";
const plans = readdirSync(path.join(ROOT, planDirectory))
  .filter((file) => file.endsWith(".json"))
  .map((file) => object(readJson(`${planDirectory}/${file}`)));
const planOperations = new Set(
  plans.flatMap((plan) =>
    array(plan.checks).flatMap((check) => {
      const value = object(check);
      return [
        string(value.operation),
        ...array(value.steps ?? []).flatMap((step) => {
          const { operation } = object(step);
          return typeof operation === "string" ? [operation] : [];
        }),
      ];
    })
  )
);
const SYSCALLS = [
  "store.put",
  "store.get",
  "store.has",
  "schema.register",
  "schema.get",
  "tree.create",
  "tree.incorporate",
  "tree.diff",
  "tree.resolve",
  "tree.manifest",
  "node.get",
  "node.walkBack",
  "branch.create",
  "branch.get",
  "branch.list",
  "branch.setHead",
  "thread.create",
  "thread.get",
  "thread.list",
  "staging.stage",
  "staging.current",
  "run.create",
  "run.beginStep",
  "run.completeStep",
  "run.recover",
  "run.complete",
  "turn.create",
  "turn.get",
  "turn.updateHead",
  "verdicts.compose",
  "maintenance.reclaim",
  "runLiveness.createLeasedRun",
  "runLiveness.renewLease",
  "runLiveness.listExpired",
  "runLiveness.preemptExpired",
];

const factoryReturnMethods = (
  declaration: ts.VariableDeclaration,
  source: ts.SourceFile,
  name: string
): string[] => {
  const factory = declaration.initializer;
  if (
    declaration.name.getText(source) !== name ||
    factory === undefined ||
    !ts.isArrowFunction(factory) ||
    !ts.isBlock(factory.body)
  ) {
    return [];
  }
  const returned = factory.body.statements.find(
    ts.isReturnStatement
  )?.expression;
  if (returned === undefined || !ts.isObjectLiteralExpression(returned)) {
    return [];
  }
  return returned.properties.flatMap((property) =>
    property.name === undefined ? [] : [property.name.getText(source)]
  );
};

const interfaceMethods = (source: ts.SourceFile, name: string): string[] => {
  const result: string[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        result.push(...factoryReturnMethods(declaration, source, name));
      }
    }
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) {
      continue;
    }
    for (const group of statement.members) {
      if (!ts.isPropertySignature(group) || group.type === undefined) {
        continue;
      }
      if (ts.isFunctionTypeNode(group.type)) {
        result.push(group.name.getText(source));
        continue;
      }
      if (!ts.isTypeLiteralNode(group.type)) {
        continue;
      }
      for (const method of group.type.members) {
        if (ts.isPropertySignature(method) && method.name !== undefined) {
          result.push(
            `${group.name.getText(source)}.${method.name.getText(source)}`
          );
        }
      }
    }
  }
  return result;
};

describe("kernel certification catalog", () => {
  test("validates catalog dialect and packet references", () => {
    expect(
      validateCertificationDocument("operationCatalog", catalog())
    ).toEqual([]);
    expect(
      collectCertificationIntegrityFailures("operationCatalog", catalog())
    ).toEqual([]);
    expect(validateCertificationDocument("authorityPacket", packet)).toEqual(
      []
    );
    expect(packet.operationCatalog).toBe(
      "spec/conformance/kernel/operations.json"
    );
    expect(packet.identityRecipes).toBe(
      "spec/conformance/kernel/identity-recipes.json"
    );
    expect(catalog().packetId).toBe(packet.packetId);
  });

  test("covers the specification and resolves every current binding through packet projections", () => {
    const current = operations().filter(
      (operation) => operation.deprecated !== true
    );
    expect(
      current
        .filter((operation) => operation.kind === "syscall")
        .map((operation) => operation.operationId)
        .toSorted((left, right) => string(left).localeCompare(string(right)))
    ).toEqual(
      SYSCALLS.map((name) => `kernel.${name}`).toSorted((left, right) =>
        string(left).localeCompare(string(right))
      )
    );
    const [, syscallText] = readFileSync(
      path.join(ROOT, "docs/KrakenKernelSpecification.md"),
      "utf-8"
    ).split("## 7. Syscall Surface");
    const [syscallSection] = string(syscallText).split("## 8.");
    for (const match of string(syscallSection).matchAll(
      /^(?<operation>[a-z]+\.[a-zA-Z]+)\(/gmu
    )) {
      expect(SYSCALLS).toContain(string(match.groups?.operation));
    }
    const projections = Object.values(object(packet.bindingProjections));
    const bindingSources = new Map([
      ["typescript/kernel/protocol", "src/lib/kernel-types.ts"],
      ["typescript/kernel/testkit", "src/lib/kernel-mutant-types.ts"],
      [
        "typescript/kernel/testkit#createKernelBarrierControl",
        "src/lib/kernel-barrier-control.ts",
      ],
    ]);
    for (const operation of current) {
      const [projection, symbol] = string(operation.binding).split("#");
      expect(projections).toContain(projection);
      if (string(projection).endsWith(".json")) {
        let target: unknown = readJson(string(projection));
        for (const segment of string(symbol).slice(1).split("/")) {
          target = object(target)[segment];
        }
        expect(target).toBeDefined();
        continue;
      }
      const [type, ...method] = string(symbol).split(".");
      const file = `${string(projection)}/${string(bindingSources.get(`${string(projection)}#${string(type)}`) ?? bindingSources.get(string(projection)))}`;
      const source = ts.createSourceFile(
        file,
        readFileSync(path.join(ROOT, file), "utf-8"),
        ts.ScriptTarget.Latest,
        true
      );
      expect(interfaceMethods(source, string(type))).toContain(
        method.join(".")
      );
      if (operation.kind === "syscall") {
        expect(operation.operationId).toBe(`kernel.${method.join(".")}`);
      }
      if (operation.kind === "syscall") {
        expect(operation.handles).toEqual({ consumes: ["instance"] });
      } else {
        expect(array(object(operation.handles).consumes)).toContain("instance");
      }
    }
  });

  test("lists every current composite as deprecated and every asserted error code", () => {
    const entries = operations();
    const nativeIds = new Set([
      ...SYSCALLS.map((name) => `kernel.${name}`),
      "kernel.barrier.arm",
      "kernel.barrier.wait",
      "kernel.barrier.release",
      "kernel.clock.set",
      "kernel.fault.arm",
      "kernel.mutant.activation",
    ]);
    for (const id of planOperations) {
      if (nativeIds.has(id)) {
        continue;
      }
      expect(
        entries.find((entry) => entry.operationId === id)?.deprecated
      ).toBe(true);
    }
    const codes = new Set(
      entries
        .filter((entry) => entry.deprecated !== true)
        .flatMap((entry) => array(entry.errors).map(string))
    );
    for (const plan of plans) {
      for (const check of array(plan.checks).map(object)) {
        for (const assertion of array(check.assertions).map(object)) {
          if (
            /code/iu.test(String(assertion.field)) &&
            typeof assertion.equals === "string"
          ) {
            expect(codes.has(assertion.equals)).toBe(true);
          }
        }
      }
    }
    expect(codes.has("turn_head_lateral_move")).toBe(false);
  });

  test("run creation errors match the specification's creation legality", () => {
    for (const id of [
      "kernel.run.create",
      "kernel.runLiveness.createLeasedRun",
    ]) {
      const entry = operations().find(
        (operation) => operation.operationId === id
      );
      expect(array(entry?.errors)).not.toContain("turn_node_thread_mismatch");
    }
  });

  test("compiles all invocation and observation schemas with their encoding references", () => {
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(
      object(
        readJson("tools/schemas/conformance-observation-encoding.schema.json")
      )
    );
    for (const entry of operations()) {
      expect(() =>
        ajv.compile(entry.input === true ? true : object(entry.input))
      ).not.toThrow();
      for (const schema of Object.values(object(entry.observation))) {
        expect(() => ajv.compile(object(schema))).not.toThrow();
      }
    }
  });

  test("declares the clock, fault, and closed mutant activation controls", () => {
    const entries = operations();
    for (const id of [
      "kernel.barrier.arm",
      "kernel.barrier.wait",
      "kernel.barrier.release",
      "kernel.clock.set",
      "kernel.fault.arm",
      "kernel.mutant.activation",
    ]) {
      expect(entries.find((entry) => entry.operationId === id)?.kind).toBe(
        "control"
      );
    }
    const clock = entries.find(
      (entry) => entry.operationId === "kernel.clock.set"
    );
    const fault = entries.find(
      (entry) => entry.operationId === "kernel.fault.arm"
    );
    expect(clock?.binding).toBe(
      "tools/conformance/adapter-protocol/protocol.schema.json#/$defs/SetClockParams"
    );
    const protocolDefs = object(
      object(
        readJson("tools/conformance/adapter-protocol/protocol.schema.json")
      ).$defs
    );
    expect(object(object(clock?.input).properties).nowMs).toEqual(
      protocolDefs.SafeCount
    );
    expect(fault?.binding).toBe(
      "tools/conformance/adapter-protocol/protocol.schema.json#/$defs/ArmFaultParams"
    );
    expect(object(object(clock?.input).properties).domain).toEqual({
      enum: ["backend", "worker"],
    });
    const mutant = entries.find(
      (entry) => entry.operationId === "kernel.mutant.activation"
    );
    const result = object(object(mutant?.observation).result);
    const activation = object(object(result.properties).activation);
    expect(activation.additionalProperties).toBe(false);
    expect(
      array(activation.required).toSorted((left, right) =>
        string(left).localeCompare(string(right))
      )
    ).toEqual(["activated", "activationCount", "kind", "mutantId", "signal"]);
  });
});

const CBOR_PROFILE = {
  argumentEncoding:
    "0..23-inline; 24..255-uint8; 256..65535-uint16; 65536..4294967295-uint32; larger-uint64; big-endian",
  arrayOrder: "preserve",
  bytesEncoding: "untagged-major-type-2",
  encoding: "deterministic-cbor",
  integerDomain: [-9_007_199_254_740_991, 9_007_199_254_740_991],
  integerEncoding:
    "major-type-0-for-n>=0; major-type-1-with-argument=-1-n-for-n<0; shortest-argument-width; no-floats",
  lengthEncoding:
    "shortest-definite-length; text-length-is-utf8-byte-count; map-length-is-entry-count",
  mapKeyOrder:
    "unsigned-bytewise-lexicographic-deterministic-cbor-encoded-text-keys",
  negativeZero: false,
  tags: false,
  textEncoding: "utf-8-without-normalization",
};
const recipes = (): Record<string, unknown>[] =>
  array(
    object(readJson("spec/conformance/kernel/identity-recipes.json")).recipes
  ).map(object);
const recipeFor = (type: string): Record<string, unknown> => {
  const recipe = recipes().find((entry) => entry.recordType === type);
  if (recipe === undefined) {
    throw new Error(`missing recipe ${type}`);
  }
  return recipe;
};
const fixtureRecord = (value: unknown, tagged: boolean): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => fixtureRecord(entry, tagged));
  }
  if (!isObject(value)) {
    return value;
  }
  if (Object.hasOwn(value, "$bytes")) {
    expect(Object.keys(value)).toEqual(["$bytes"]);
    return Uint8Array.from(Buffer.from(string(value.$bytes), "hex"));
  }
  const entries =
    tagged && Object.hasOwn(value, "$map")
      ? array(value.$map).map((entry): [string, unknown] => {
          const pair = array(entry);
          expect(pair).toHaveLength(2);
          return [string(pair[0]), pair[1]];
        })
      : Object.entries(value);
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, fixtureRecord(entry, tagged)])
  );
};
const project = (
  value: unknown,
  projection: Record<string, unknown>
): Record<string, unknown> => {
  const source = object(value);
  const optional = array(projection.optionalFields ?? []);
  return Object.fromEntries(
    array(projection.fields).flatMap((field) => {
      const name = string(field);
      if (!Object.hasOwn(source, name)) {
        if (!optional.includes(name)) {
          throw new Error(`missing identity field ${name}`);
        }
        return [];
      }
      const nested = projection.stagedResultProjection;
      const projected =
        name === "consumedStagedResults" && nested !== undefined
          ? array(source[name]).map((entry) => project(entry, object(nested)))
          : source[name];
      return [[name, projected]];
    })
  );
};
const identityBytes = (
  type: string,
  value: unknown,
  tagged = false
): Uint8Array => {
  const recipe = recipeFor(type);
  expect(recipe.hash).toBe("sha256");
  if (type === "opaque-object") {
    expect(recipe.cborProfile).toEqual({ encoding: "raw-bytes" });
    expect(recipe.projection).toEqual({ source: "bytes" });
    if (Array.isArray(value)) {
      return Uint8Array.from(value);
    }
    return Uint8Array.from(Buffer.from(string(object(value).$bytes), "hex"));
  }
  expect(recipe.cborProfile).toEqual(CBOR_PROFILE);
  const projected = project(
    fixtureRecord(value, tagged),
    object(recipe.projection)
  );
  assertKernelRecord(projected);
  return encodeDeterministicKernelRecord(projected);
};
const digest = (type: string, bytes: Uint8Array): string =>
  createHash(string(recipeFor(type).hash))
    .update(bytes)
    .digest("hex");

describe("kernel identity recipes", () => {
  test("declare exactly the four identity families and preserve optional staged fields", () => {
    expect(
      recipes()
        .map((entry) => entry.recordType)
        .toSorted((left, right) => string(left).localeCompare(string(right)))
    ).toEqual(["opaque-object", "schema", "turn-node", "turn-tree"]);
    expect(recipeFor("turn-node").projection).toEqual({
      fields: [
        "schemaId",
        "turnTreeHash",
        "previousTurnNodeHash",
        "eventHash",
        "consumedStagedResults",
      ],
      stagedResultProjection: {
        fields: [
          "taskId",
          "objectHash",
          "objectType",
          "status",
          "timestamp",
          "interruptPayload",
        ],
        optionalFields: ["interruptPayload"],
      },
    });
    expect(recipeFor("schema").projection).toEqual({
      fields: ["schemaId", "paths", "incorporationRules"],
    });
    expect(recipeFor("turn-tree").projection).toEqual({
      fields: ["schemaId", "manifest"],
    });
  });

  const fixtureDirectory = "spec/conformance/kernel/fixtures";
  test("pins the expanded vector inventory", () => {
    const files = readdirSync(path.join(ROOT, fixtureDirectory)).filter(
      (name) => name.endsWith(".json")
    );
    expect(files).toHaveLength(54);
    const totals = { cborBytes: 0, cborHex: 0, digests: 0 };
    for (const file of files) {
      const fixture = object(readJson(`${fixtureDirectory}/${file}`));
      const expected = Object.hasOwn(fixture, "expected")
        ? object(fixture.expected)
        : fixture;
      for (const key of Object.keys(expected)) {
        if (key.endsWith("Sha256Hex")) {
          totals.digests += 1;
        }
        if (key.endsWith("CborHex")) {
          totals.cborHex += 1;
        }
        if (key.endsWith("CborBytes")) {
          totals.cborBytes += 1;
        }
      }
    }
    expect(totals).toEqual({ cborBytes: 42, cborHex: 84, digests: 120 });
    for (const name of [
      "nested-byte-string",
      "nested-integer-array",
      "integer-widths",
      "non-identity-hash",
    ]) {
      expect(files).toContain(`kernel-protocol-${name}.json`);
      expect(files).toContain(`kernel-protocol-${name}.bytes.json`);
    }
  });
  test("vectors distinguish nested bytes, signed integer widths, and excluded hashes", () => {
    const bytes = readIdentityFixture("nested-byte-string");
    const integers = readIdentityFixture("nested-integer-array");
    expect(nodePayload(bytes)).toEqual({ $bytes: "000118ff" });
    expect(nodePayload(integers)).toEqual([0, 1, 24, 255]);
    expect(bytes.turnNodeIdentityRecordCborHex).not.toBe(
      integers.turnNodeIdentityRecordCborHex
    );
    expect(bytes.turnNodeIdentityRecordSha256Hex).not.toBe(
      integers.turnNodeIdentityRecordSha256Hex
    );
    expect(nodePayload(readIdentityFixture("integer-widths"))).toEqual([
      0, 23, 24, 255, 256, 65_535, 65_536, 4_294_967_295, 4_294_967_296,
      9_007_199_254_740_991, -1, -24, -25, -256, -257, -65_536, -65_537,
      -4_294_967_296, -4_294_967_297, -9_007_199_254_740_991,
    ]);
    const excluded = readIdentityFixture("non-identity-hash");
    for (const [field, control] of [
      ["turnNodeIdentityRecord", readIdentityFixture("deterministic")],
      ["turnTreeIdentityRecord", readIdentityFixture("turn-tree")],
    ] as const) {
      expect(object(excluded[field])).toHaveProperty("hash");
      expect(excluded[`${field}CborHex`]).toBe(control[`${field}CborHex`]);
      expect(excluded[`${field}Sha256Hex`]).toBe(control[`${field}Sha256Hex`]);
    }
  });
  for (const file of readdirSync(path.join(ROOT, fixtureDirectory)).filter(
    (name) => name.endsWith(".json")
  )) {
    const fixture = object(readJson(`${fixtureDirectory}/${file}`));
    const tagged = Object.hasOwn(fixture, "input");
    const input = tagged ? object(fixture.input) : fixture;
    const expected = tagged ? object(fixture.expected) : fixture;
    for (const key of Object.keys(expected).filter((name) =>
      name.endsWith("Sha256Hex")
    )) {
      test(`${file}: ${key} is reproduced from its recipe`, () => {
        const field = key.slice(0, -"Sha256Hex".length);
        const types: Record<string, string> = {
          rawOpaqueBytes: "opaque-object",
          turnNodeIdentityRecord: "turn-node",
          turnTreeIdentityRecord: "turn-tree",
          turnTreeSchemaRecord: "schema",
        };
        const type = types[field];
        if (type === undefined) {
          throw new Error(`unmapped committed digest ${key}`);
        }
        const bytes = identityBytes(type, input[field], tagged);
        expect(digest(type, bytes)).toBe(string(expected[key]));
        if (type !== "opaque-object") {
          expect(Buffer.from(bytes).toString("hex")).toBe(
            string(expected[`${field}CborHex`])
          );
          if (tagged) {
            expect(Buffer.from(bytes).toString("hex")).toBe(
              string(object(expected[`${field}CborBytes`]).$bytes)
            );
          }
        }
      });
    }
  }

  test("TurnTree recipe and public identity operation reproduce the committed vector", async () => {
    const fixture = object(
      readJson(`${fixtureDirectory}/kernel-protocol-turn-tree.json`)
    );
    const schema = readJson(
      `${fixtureDirectory}/canonical-turn-tree-schema.json`
    );
    const record = object(fixture.turnTreeIdentityRecord);
    const { manifest } = record;
    assertTurnTreeSchema(schema);
    assertTurnTreeManifest(manifest);
    const bytes = identityBytes("turn-tree", {
      hash: "excluded",
      ...record,
    });
    expect(Buffer.from(bytes).toString("hex")).toBe(
      string(fixture.turnTreeIdentityRecordCborHex)
    );
    expect(digest("turn-tree", bytes)).toBe(
      string(fixture.turnTreeIdentityRecordSha256Hex)
    );
    expect(
      await hashTurnTreeIdentity(string(record.schemaId), manifest, schema)
    ).toBe(string(fixture.turnTreeIdentityRecordSha256Hex));
  });
});
