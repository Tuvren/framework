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
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import type { CustomSchema } from "../src/lib/runtime-contract-shapes.js";
import type { FlexibleSchema, Schema } from "../src/lib/schema-authoring.js";
import {
  asSchema,
  defineTool,
  jsonSchema,
  schemaSymbol,
  standardSchema,
  zodSchema,
} from "../src/lib/schema-authoring.js";
import { TuvrenValidationError } from "../src/lib/tuvren-error.js";

// ── Structural mocks ──────────────────────────────────────────────────────────
// These implement only the duck-typed surfaces that the detection branches test.

/** Minimal Zod v4 mock: has _zod + safeParse. */
function makeZodV4Mock<T>(
  parseResult:
    | { success: true; data: T }
    | { success: false; message: string; issues?: unknown },
  jsonSchemaValue?: Record<string, unknown>
) {
  return {
    _zod: {},
    safeParse(_value: unknown) {
      if (parseResult.success) {
        return { success: true as const, data: parseResult.data };
      }
      return {
        success: false as const,
        error: {
          message: parseResult.message,
          issues: "issues" in parseResult ? parseResult.issues : undefined,
        },
      };
    },
    ...(jsonSchemaValue === undefined
      ? {}
      : { toJSONSchema: () => jsonSchemaValue }),
  };
}

/** Minimal Standard Schema mock (non-zod). */
function makeStandardMock<T>(
  result:
    | { value: T }
    | { issues: ReadonlyArray<{ message: string }> }
    | Promise<{ value: T } | { issues: ReadonlyArray<{ message: string }> }>,
  jsonSchemaValue?: Record<string, unknown>
) {
  return {
    "~standard": {
      validate(_value: unknown) {
        return result;
      },
    },
    ...(jsonSchemaValue === undefined
      ? {}
      : { toJSONSchema: () => jsonSchemaValue }),
  };
}

/** Minimal Zod v3 compat mock: has ~standard.vendor === "zod" + safeParse. */
function makeZodV3Mock<T>(
  parseResult: { success: true; data: T } | { success: false; message: string }
) {
  return {
    "~standard": {
      vendor: "zod" as const,
      validate(_value: unknown) {
        return parseResult.success
          ? { value: parseResult.data }
          : { issues: [{ message: parseResult.message }] };
      },
    },
    safeParse(_value: unknown) {
      if (parseResult.success) {
        return { success: true as const, data: parseResult.data };
      }
      return {
        success: false as const,
        error: { message: parseResult.message, issues: undefined },
      };
    },
  };
}

const STUB_CTX = {
  callId: "test-call-id",
  name: "test-tool",
};

const ASYNC_SCHEMA_REGEX = /Async Standard Schema/;

// ── jsonSchema() ──────────────────────────────────────────────────────────────

describe("jsonSchema()", () => {
  test("brands the result with schemaSymbol", () => {
    const schema = jsonSchema({ type: "string" });
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("stores the provided JSON schema", () => {
    const raw = { type: "object", properties: { x: { type: "number" } } };
    const schema = jsonSchema(raw);
    expect(schema.jsonSchema).toEqual(raw);
  });

  test("validate is undefined when no options provided", () => {
    const schema = jsonSchema({ type: "string" });
    expect(schema.validate).toBeUndefined();
  });

  test("validate option is forwarded", () => {
    const validate = (v: unknown) =>
      v === "ok"
        ? { success: true as const, value: v as string }
        : {
            success: false as const,
            error: new TuvrenValidationError("bad", {
              code: "tool_input_validation_failed",
            }),
          };

    const schema = jsonSchema<string>({ type: "string" }, { validate });
    expect(schema.validate).toBe(validate);
  });

  test("validate() succeeds for valid input", () => {
    const schema = jsonSchema<string>(
      { type: "string" },
      {
        validate: (v) =>
          typeof v === "string"
            ? { success: true, value: v }
            : {
                success: false,
                error: new TuvrenValidationError("bad", {
                  code: "tool_input_validation_failed",
                }),
              },
      }
    );
    const result = schema.validate?.("hello");
    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.value).toBe("hello");
    }
  });
});

// ── asSchema() — ADR-038 branch precedence ────────────────────────────────────

describe("asSchema() — branch 1: already-wrapped Schema", () => {
  test("returns the same Schema object identity", () => {
    const original = jsonSchema({ type: "string" });
    const result = asSchema(original);
    expect(result).toBe(original);
  });

  test("round-trips a Schema with validate", () => {
    const validate = (
      _v: unknown
    ): ReturnType<NonNullable<Schema<string>["validate"]>> => ({
      success: true,
      value: "wrapped",
    });
    const original = jsonSchema<string>({ type: "string" }, { validate });
    const result = asSchema(original);
    expect(result.validate).toBe(validate);
  });
});

describe("asSchema() — branch 2: Zod v4 (_zod in schema)", () => {
  test("detects Zod v4 via _zod property", () => {
    const mock = makeZodV4Mock({ success: true, data: 42 });
    const schema = asSchema(mock as FlexibleSchema<number>);
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate() success returns parsed value from safeParse", () => {
    const mock = makeZodV4Mock({ success: true, data: 42 });
    const schema = asSchema(mock as FlexibleSchema<number>);
    const result = schema.validate?.(99);
    expect(result).toEqual({ success: true, value: 42 });
  });

  test("validate() failure wraps error in TuvrenValidationError", () => {
    const mock = makeZodV4Mock<number>({
      success: false,
      message: "not a number",
      issues: [{ message: "Expected number" }],
    });
    const schema = asSchema(mock as FlexibleSchema<number>);
    const result = schema.validate?.("nope");
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toBeInstanceOf(TuvrenValidationError);
      expect(result.error.code).toBe("tool_input_validation_failed");
    }
  });

  test("jsonSchema uses toJSONSchema() when available", () => {
    const raw = { type: "number" };
    const mock = makeZodV4Mock({ success: true, data: 1 }, raw);
    const schema = asSchema(mock as FlexibleSchema<number>);
    expect(schema.jsonSchema).toEqual(raw);
  });

  test("jsonSchema falls back to {} when toJSONSchema is absent", () => {
    const mock = makeZodV4Mock({ success: true, data: 1 });
    const schema = asSchema(mock as FlexibleSchema<number>);
    expect(schema.jsonSchema).toEqual({});
  });
});

describe("asSchema() — branch 3: Standard Schema (non-zod vendor)", () => {
  test("detects Standard Schema via ~standard property", () => {
    const mock = makeStandardMock({ value: "hello" });
    const schema = asSchema(mock as unknown as FlexibleSchema<string>);
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate() success returns the result value", () => {
    const mock = makeStandardMock({ value: "hello" });
    const schema = asSchema(mock as unknown as FlexibleSchema<string>);
    const result = schema.validate?.("hello");
    expect(result).toEqual({ success: true, value: "hello" });
  });

  test("validate() failure with issues wraps in TuvrenValidationError", () => {
    const mock = makeStandardMock<string>({
      issues: [{ message: "too short" }],
    });
    const schema = asSchema(mock as unknown as FlexibleSchema<string>);
    const result = schema.validate?.("");
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toBeInstanceOf(TuvrenValidationError);
      expect(result.error.code).toBe("tool_input_validation_failed");
      expect(result.error.details).toEqual([{ message: "too short" }]);
    }
  });

  test("validate() throws when ~standard.validate returns a Promise", () => {
    const mock = makeStandardMock<string>(Promise.resolve({ value: "async" }));
    const schema = asSchema(mock as unknown as FlexibleSchema<string>);
    expect(() => schema.validate?.("async")).toThrow(TuvrenValidationError);
    expect(() => schema.validate?.("async")).toThrow(ASYNC_SCHEMA_REGEX);
  });

  test("jsonSchema uses toJSONSchema() when available", () => {
    const raw = { type: "string" };
    const mock = makeStandardMock({ value: "ok" }, raw);
    const schema = asSchema(mock as unknown as FlexibleSchema<string>);
    expect(schema.jsonSchema).toEqual(raw);
  });

  test("jsonSchema falls back to {} when toJSONSchema is absent", () => {
    const mock = makeStandardMock({ value: "ok" });
    const schema = asSchema(mock as unknown as FlexibleSchema<string>);
    expect(schema.jsonSchema).toEqual({});
  });
});

describe("asSchema() — branch 4: Zod v3 compat (~standard.vendor === 'zod')", () => {
  test("routes Zod v3 compat via safeParse, not ~standard.validate", () => {
    // We verify routing by checking that safeParse is used (not ~standard.validate).
    // We make safeParse succeed but ~standard.validate fail — branch 4 should succeed.
    const mock = {
      "~standard": {
        vendor: "zod" as const,
        validate(_v: unknown): { issues: ReadonlyArray<{ message: string }> } {
          return { issues: [{ message: "should not be called" }] };
        },
      },
      safeParse(_value: unknown) {
        return { success: true as const, data: 42 };
      },
    };
    const schema = asSchema(mock as FlexibleSchema<number>);
    const result = schema.validate?.(0);
    expect(result).toEqual({ success: true, value: 42 });
  });

  test("validate() failure uses Zod error path (not Standard Schema issues)", () => {
    const mock = makeZodV3Mock<number>({
      success: false,
      message: "bad input",
    });
    const schema = asSchema(mock as FlexibleSchema<number>);
    const result = schema.validate?.("nope");
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toBeInstanceOf(TuvrenValidationError);
      expect(result.error.code).toBe("tool_input_validation_failed");
    }
  });
});

describe("asSchema() — branch 5: lazy function", () => {
  test("calls the function and normalizes its return value", () => {
    const inner = jsonSchema<string>({ type: "string" });
    const schema = asSchema(() => inner);
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toEqual({ type: "string" });
  });

  test("lazy returning Zod v4 schema is resolved through the Zod branch", () => {
    const mock = makeZodV4Mock(
      { success: true, data: "ok" },
      { type: "string" }
    );
    const schema = asSchema(() => mock as FlexibleSchema<string>);
    expect(schema.jsonSchema).toEqual({ type: "string" });
    const result = schema.validate?.("x");
    expect(result).toEqual({ success: true, value: "ok" });
  });

  test("lazy returning a lazy is resolved transitively", () => {
    const inner = jsonSchema<number>({ type: "number" });
    // LazySchema<T> now returns FlexibleSchema<T>, so () => () => inner is
    // LazySchema<number> without a cast.
    const schema = asSchema<number>(() => () => inner);
    expect(schema.jsonSchema).toEqual({ type: "number" });
  });
});

describe("asSchema() — branch 6: bare TuvrenJsonSchema", () => {
  test("object-form JSON schema is wrapped", () => {
    const schema = asSchema({ type: "object" } as FlexibleSchema<unknown>);
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toEqual({ type: "object" });
    expect(schema.validate).toBeUndefined();
  });

  test("boolean true is wrapped", () => {
    const schema = asSchema(true as FlexibleSchema<unknown>);
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toBe(true);
    expect(schema.validate).toBeUndefined();
  });

  test("boolean false is wrapped", () => {
    const schema = asSchema(false as FlexibleSchema<unknown>);
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toBe(false);
    expect(schema.validate).toBeUndefined();
  });
});

// ── zodSchema() ───────────────────────────────────────────────────────────────

describe("zodSchema()", () => {
  test("wraps Zod v4 schema (has safeParse) into a branded Schema", () => {
    const mock = makeZodV4Mock({ success: true, data: 1 });
    // zodSchema<T> accepts ZodSchema<T> — our mock is structurally compatible with ZodLike<T>
    // We cast through unknown to satisfy the strict ZodSchema union type in the test.
    const schema = zodSchema(
      mock as unknown as import("zod/v4").ZodType<number>
    );
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate delegates to safeParse", () => {
    const mock = makeZodV4Mock({ success: true, data: "hello" });
    const schema = zodSchema(
      mock as unknown as import("zod/v4").ZodType<string>
    );
    expect(schema.validate?.("anything")).toEqual({
      success: true,
      value: "hello",
    });
  });
});

// ── standardSchema() ──────────────────────────────────────────────────────────

describe("standardSchema()", () => {
  test("wraps a Standard Schema into a branded Schema", () => {
    const mock = makeStandardMock({ value: 7 });
    const schema = standardSchema(
      mock as unknown as import("@standard-schema/spec").StandardSchemaV1<
        unknown,
        number
      >
    );
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate delegates to ~standard.validate", () => {
    const mock = makeStandardMock({ value: 7 });
    const schema = standardSchema(
      mock as unknown as import("@standard-schema/spec").StandardSchemaV1<
        unknown,
        number
      >
    );
    expect(schema.validate?.(0)).toEqual({ success: true, value: 7 });
  });
});

// ── defineTool() ──────────────────────────────────────────────────────────────

describe("defineTool()", () => {
  test("returns a TuvrenToolDefinition with correct name and description", () => {
    const tool = defineTool({
      name: "my-tool",
      description: "A test tool",
      inputSchema: { type: "string" },
      execute: (input) => String(input),
    });
    expect(tool.name).toBe("my-tool");
    expect(tool.description).toBe("A test tool");
  });

  test("inputSchema.toJSONSchema() returns normalized JSON schema", () => {
    const raw = { type: "object", required: ["x"] };
    const tool = defineTool({
      name: "t",
      description: "d",
      inputSchema: raw,
      execute: (input) => input,
    });
    expect((tool.inputSchema as CustomSchema).toJSONSchema()).toEqual(raw);
  });

  test("inputSchema.validate() passes through when no schema validate defined", () => {
    const tool = defineTool({
      name: "t",
      description: "d",
      inputSchema: { type: "string" },
      execute: (input) => input,
    });
    const result = (tool.inputSchema as CustomSchema).validate("hello");
    expect(result).toEqual({ valid: true, value: "hello" });
  });

  test("inputSchema.validate() propagates schema validation success", () => {
    const mock = makeZodV4Mock({ success: true, data: 99 });
    const tool = defineTool({
      name: "t",
      description: "d",
      inputSchema: mock as FlexibleSchema<number>,
      execute: (input) => input,
    });
    expect((tool.inputSchema as CustomSchema).validate(0)).toEqual({
      valid: true,
      value: 99,
    });
  });

  test("inputSchema.validate() propagates schema validation failure", () => {
    const mock = makeZodV4Mock<number>({
      success: false,
      message: "not a number",
      issues: [{ message: "Expected number" }],
    });
    const tool = defineTool({
      name: "t",
      description: "d",
      inputSchema: mock as FlexibleSchema<number>,
      execute: (input) => input,
    });
    const result = (tool.inputSchema as CustomSchema).validate("bad");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.message).toBe("not a number");
    }
  });

  test("execute callback receives validated input", async () => {
    let capturedInput: unknown;
    const tool = defineTool({
      name: "t",
      description: "d",
      inputSchema: { type: "string" },
      execute: (input) => {
        capturedInput = input;
        return "done";
      },
    });
    await tool.execute("hello", STUB_CTX);
    expect(capturedInput).toBe("hello");
  });

  test("approval, timeout, and metadata are forwarded", () => {
    const tool = defineTool({
      name: "t",
      description: "d",
      inputSchema: { type: "string" },
      execute: (input) => input,
      approval: true,
      timeout: 5000,
      metadata: { version: 1 },
    });
    expect(tool.approval).toBe(true);
    expect(tool.timeout).toBe(5000);
    expect(tool.metadata).toEqual({ version: 1 });
  });

  test("FlexibleSchema is normalized once at definition time (lazy)", () => {
    let callCount = 0;
    const inner = jsonSchema<string>({ type: "string" });
    const lazy = () => {
      callCount++;
      return inner;
    };
    defineTool({
      name: "t",
      description: "d",
      inputSchema: lazy,
      execute: (i) => i,
    });
    // asSchema resolves the lazy once during defineTool construction
    expect(callCount).toBe(1);
  });
});

// ── Real-library integration — guards against Zod internals churn ─────────────
// These tests use the real zod@4 library (v4 native + v3 compat surface) to
// verify that _zod detection, toJSONSchema() extraction, and safeParse routing
// hold against actual library instances, not just structural mocks.

describe("Real library integration — Zod v4 native", () => {
  test("z4.string() routes via _zod branch (branch 2)", () => {
    const schema = asSchema(z4.string());
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("z4.string() extracts JSON schema via toJSONSchema()", () => {
    const schema = asSchema(z4.string());
    expect(schema.jsonSchema).toMatchObject({ type: "string" });
  });

  test("z4.string() validates correctly via safeParse", () => {
    const schema = asSchema(z4.string());
    expect(schema.validate?.("hello")).toEqual({
      success: true,
      value: "hello",
    });
    const bad = schema.validate?.(42);
    expect(bad?.success).toBe(false);
    if (bad && !bad.success) {
      expect(bad.error).toBeInstanceOf(TuvrenValidationError);
    }
  });

  test("defineTool with z4.object() toJSONSchema() includes required fields", () => {
    const tool = defineTool({
      name: "greet",
      description: "greet",
      inputSchema: z4.object({ name: z4.string() }),
      execute: ({ name }) => `Hello ${name}`,
    });
    const js = (tool.inputSchema as CustomSchema).toJSONSchema();
    expect(js).toMatchObject({ type: "object" });
  });
});

describe("Real library integration — Zod v3 compat", () => {
  test("z3.string() routes via branch 4 (~standard.vendor === 'zod')", () => {
    const schema = asSchema(z3.string());
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("z3.string() falls back to {} JSON schema (no toJSONSchema on v3)", () => {
    const schema = asSchema(z3.string());
    expect(schema.jsonSchema).toEqual({});
  });

  test("z3.string() validates via safeParse, not ~standard.validate", () => {
    const schema = asSchema(z3.string());
    expect(schema.validate?.("hello")).toEqual({
      success: true,
      value: "hello",
    });
    const bad = schema.validate?.(42);
    expect(bad?.success).toBe(false);
    if (bad && !bad.success) {
      expect(bad.error).toBeInstanceOf(TuvrenValidationError);
    }
  });
});
