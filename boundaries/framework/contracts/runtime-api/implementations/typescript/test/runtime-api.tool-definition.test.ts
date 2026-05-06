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
import { isTuvrenToolDefinition } from "../src/index.ts";

describe("runtime-api tool definition contracts", () => {
  test("rejects tool definitions with invalid schemas", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: 123,
        name: "search",
      })
    ).toBe(false);
  });

  test("rejects tool definitions with malformed JSON Schema objects", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Bad required schema",
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
        inputSchema: {
          type: "banana",
        },
        name: "bad-type",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad schema type array",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: ["object", "banana"],
        },
        name: "bad-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad empty schema type array",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: [],
        },
        name: "bad-empty-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate schema type array",
        execute() {
          return undefined;
        },
        inputSchema: {
          type: ["string", "string"],
        },
        name: "bad-duplicate-type-array",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad duplicate required entries",
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
        inputSchema: {
          oneOf: [123],
        },
        name: "bad-one-of-schema",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad minLength schema",
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
        inputSchema: {
          oneOf: [],
        },
        name: "bad-empty-one-of",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad $ref schema",
        execute() {
          return undefined;
        },
        inputSchema: {
          $ref: 123,
        },
        name: "bad-ref",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Bad $defs schema",
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
        inputSchema: {
          description: 123,
          type: "string",
        },
        name: "bad-description",
      })
    ).toBe(false);
  });

  test("accepts structurally valid CustomSchema class instances", () => {
    class ExampleSchema {
      toJSONSchema() {
        return { type: "string" };
      }

      validate(input: unknown) {
        if (typeof input === "string") {
          return { valid: true, value: input };
        }

        return {
          error: { message: "Expected string" },
          valid: false,
        };
      }
    }

    expect(
      isTuvrenToolDefinition({
        description: "Class-backed schema tool",
        execute() {
          return undefined;
        },
        inputSchema: new ExampleSchema(),
        name: "class-schema",
      })
    ).toBe(true);
  });

  test("accepts structurally valid CustomSchema shapes without executing them", () => {
    let methodCalls = 0;
    class LazySchema {
      toJSONSchema() {
        methodCalls += 1;
        return 123;
      }

      validate() {
        methodCalls += 1;
        return { valid: true, value: "ok" };
      }
    }

    expect(
      isTuvrenToolDefinition({
        description: "Lazy custom schema",
        execute() {
          return undefined;
        },
        inputSchema: new LazySchema(),
        name: "lazy-custom-schema",
      })
    ).toBe(true);
    expect(methodCalls).toBe(0);
  });

  test("accepts JSON Schema numeric keywords with fractional values", () => {
    expect(
      isTuvrenToolDefinition({
        description: "Constrained number tool",
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
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
        execute() {
          return undefined;
        },
        inputSchema: true,
        name: "search",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: true,
        metadata: 7,
        name: "search",
      })
    ).toBe(false);

    expect(
      isTuvrenToolDefinition({
        description: "Search",
        execute() {
          return undefined;
        },
        inputSchema: true,
        name: "search",
        timeout: Number.POSITIVE_INFINITY,
      })
    ).toBe(false);
  });
});
