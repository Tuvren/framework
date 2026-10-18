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

// Ported from the retired @tuvren/runtime-api shim (epic 87, M9.2). The shim
// re-exported this vocabulary from @tuvren/core/tools without adding
// behavior; only the import source changed below.

import { describe, expect, test } from "bun:test";

import { isTuvrenToolDefinition } from "../src/tools/index.js";

class ExampleCustomSchema {
  private readonly lazy: boolean;
  methodCalls = 0;

  constructor(lazy = false) {
    this.lazy = lazy;
  }

  toJSONSchema() {
    if (this.lazy) {
      this.methodCalls += 1;
      return 123;
    }

    return { type: "string" };
  }

  validate(input: unknown) {
    if (this.lazy) {
      this.methodCalls += 1;
      return { valid: true, value: "ok" };
    }

    if (typeof input === "string") {
      return { valid: true, value: input };
    }

    return {
      error: { message: "Expected string" },
      valid: false,
    };
  }
}

describe("runtime-contract-guards tool definition contracts", () => {
  test("rejects tool definitions with invalid schemas", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {},
        inputSchema: 123,
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with malformed JSON Schema objects", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Bad required schema",
        execute() {},
        inputSchema: {
          required: [7],
          type: "object",
        },
        name: "bad-required",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad properties schema",
        execute() {},
        inputSchema: {
          properties: "oops",
          type: "object",
        },
        name: "bad-properties",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad nested property schema",
        execute() {},
        inputSchema: {
          properties: {
            foo: 1,
          },
          type: "object",
        },
        name: "bad-nested-properties",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad schema type",
        execute() {},
        inputSchema: {
          type: "banana",
        },
        name: "bad-type",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad schema type array",
        execute() {},
        inputSchema: {
          type: ["object", "banana"],
        },
        name: "bad-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty schema type array",
        execute() {},
        inputSchema: {
          type: [],
        },
        name: "bad-empty-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate schema type array",
        execute() {},
        inputSchema: {
          type: ["string", "string"],
        },
        name: "bad-duplicate-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate required entries",
        execute() {},
        inputSchema: {
          properties: {
            a: { type: "string" },
          },
          required: ["a", "a"],
          type: "object",
        },
        name: "bad-duplicate-required",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad items schema",
        execute() {},
        inputSchema: {
          items: 123,
          type: "array",
        },
        name: "bad-items-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad additionalProperties schema",
        execute() {},
        inputSchema: {
          additionalProperties: 123,
          type: "object",
        },
        name: "bad-additional-properties-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad propertyNames schema",
        execute() {},
        inputSchema: {
          propertyNames: 123,
          type: "object",
        },
        name: "bad-property-names-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad oneOf schema",
        execute() {},
        inputSchema: {
          oneOf: [123],
        },
        name: "bad-one-of-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad minLength schema",
        execute() {},
        inputSchema: {
          minLength: "abc",
          type: "string",
        },
        name: "bad-min-length",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad enum schema",
        execute() {},
        inputSchema: {
          enum: "not-an-array",
          type: "string",
        },
        name: "bad-enum",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty enum schema",
        execute() {},
        inputSchema: {
          enum: [],
          type: "string",
        },
        name: "bad-empty-enum",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate enum schema",
        execute() {},
        inputSchema: {
          enum: ["a", "a"],
          type: "string",
        },
        name: "bad-duplicate-enum",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad allOf schema",
        execute() {},
        inputSchema: {
          allOf: "oops",
          type: "string",
        },
        name: "bad-all-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad anyOf schema",
        execute() {},
        inputSchema: {
          anyOf: 123,
          type: "string",
        },
        name: "bad-any-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad prefixItems schema",
        execute() {},
        inputSchema: {
          prefixItems: 123,
          type: "array",
        },
        name: "bad-prefix-items",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty oneOf schema",
        execute() {},
        inputSchema: {
          oneOf: [],
        },
        name: "bad-empty-one-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad $ref schema",
        execute() {},
        inputSchema: {
          $ref: 123,
        },
        name: "bad-ref",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad $defs schema",
        execute() {},
        inputSchema: {
          $defs: [1],
          type: "object",
        },
        name: "bad-defs",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad title schema",
        execute() {},
        inputSchema: {
          title: 123,
          type: "string",
        },
        name: "bad-title",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad description schema",
        execute() {},
        inputSchema: {
          description: 123,
          type: "string",
        },
        name: "bad-description",
      })
    ).toBe(false);
  });

  test("accepts structurally valid CustomSchema class instances", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Class-backed schema tool",
        execute() {},
        inputSchema: new ExampleCustomSchema(),
        name: "class-schema",
      })
    ).toBe(true);
  });

  test("accepts structurally valid CustomSchema shapes without executing them", () => {
    const schema = new ExampleCustomSchema(true);

    expect(
      isTuvrenToolDefinition({
        description: "Lazy custom schema",
        execute() {},
        inputSchema: schema,
        name: "lazy-custom-schema",
      })
    ).toBe(true);
    expect(schema.methodCalls).toBe(0);
  });

  test("accepts JSON Schema numeric keywords with fractional values", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Constrained number tool",
        execute() {},
        inputSchema: {
          multipleOf: 0.1,
          type: "number",
        },
        name: "fractional-schema",
      })
    ).toBe(true);
  });

  test("accepts structurally valid but unsatisfiable JSON Schemas", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Unsatisfiable numeric bounds",
        execute() {},
        inputSchema: {
          maximum: 3,
          minimum: 5,
          type: "number",
        },
        name: "unsat-bounds",
      })
    ).toBe(true);
  });

  test("rejects tool definitions with undeclared fields", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {},
        extra: 1,
        inputSchema: true,
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with non-serializable metadata", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {},
        inputSchema: true,
        metadata: {
          fn() {
            return 1;
          },
        },
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with malformed optional behavior fields", () => {
    expect(
      isTuvrenToolDefinition({
        approval: 7,
        description: "Search",
        execute() {},
        inputSchema: true,
        name: "search",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {},
        inputSchema: true,
        metadata: 7,
        name: "search",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {},
        inputSchema: true,
        name: "search",
        timeout: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
  });
});
