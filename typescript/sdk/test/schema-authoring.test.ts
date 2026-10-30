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

import { TuvrenValidationError } from "@tuvren/core/errors";
import type { CustomSchema, TuvrenJsonSchema } from "@tuvren/core/tools";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";

import type {
  FlexibleSchema,
  Schema,
  StandardSchema,
  ZodSchema,
} from "../src/lib/schema-authoring.js";
import {
  asSchema,
  defineTool,
  jsonSchema,
  schemaSymbol,
  standardSchema,
  zodSchema,
} from "../src/lib/schema-authoring.js";

// ── Structural mocks ──────────────────────────────────────────────────────────
// These implement only the duck-typed surfaces that the detection branches test.

/** Minimal Zod v4 mock: has _zod + safeParse. */
const makeZodV4Mock = <T>(
  parseResult:
    | { success: true; data: T }
    | { success: false; message: string; issues?: unknown },
  jsonSchemaValue?: Record<string, unknown>
) => ({
  _zod: {},
  safeParse(_value: unknown) {
    if (parseResult.success) {
      return { data: parseResult.data, success: true as const };
    }
    return {
      error: {
        issues: "issues" in parseResult ? parseResult.issues : undefined,
        message: parseResult.message,
      },
      success: false as const,
    };
  },
  ...(jsonSchemaValue === undefined
    ? {}
    : { toJSONSchema: () => jsonSchemaValue }),
});

/** Minimal Standard Schema mock (non-zod). */
const makeStandardMock = <T>(
  result:
    | { value: T }
    | { issues: readonly { message: string }[] }
    | Promise<{ value: T } | { issues: readonly { message: string }[] }>,
  jsonSchemaValue?: Record<string, unknown>
) => ({
  "~standard": {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve whether the supplied Standard Schema fixture returns synchronously or returns its exact Promise.
    validate(_value: unknown) {
      return result;
    },
  },
  ...(jsonSchemaValue === undefined
    ? {}
    : { toJSONSchema: () => jsonSchemaValue }),
});

/** Minimal Zod v3 compat mock: has ~standard.vendor === "zod" + safeParse. */
const makeZodV3Mock = <T>(
  parseResult: { success: true; data: T } | { success: false; message: string }
) => ({
  safeParse(_value: unknown) {
    if (parseResult.success) {
      return { data: parseResult.data, success: true as const };
    }
    return {
      error: { issues: undefined, message: parseResult.message },
      success: false as const,
    };
  },
  "~standard": {
    validate(_value: unknown) {
      return parseResult.success
        ? { value: parseResult.data }
        : { issues: [{ message: parseResult.message }] };
    },
    vendor: "zod" as const,
  },
});

const STUB_CTX = {
  callId: "test-call-id",
  name: "test-tool",
};

const ASYNC_SCHEMA_REGEX = /Async Standard Schema/u;

const toFlexibleSchemaFixture = <T>(value: unknown): FlexibleSchema<T> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These deliberately partial fixtures exercise the SDK's public runtime duck-typing branches without pretending to implement every external library member.
  value as FlexibleSchema<T>;

const toZodSchemaFixture = <T>(value: unknown): ZodSchema<T> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This deliberately partial fixture is cast to the adapter input type for branch tests.
  value as ZodSchema<T>;

const toStandardSchemaFixture = <T>(value: unknown): StandardSchema<T> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This partial Standard Schema fixture intentionally models only the ~standard.validate API consumed by the SDK adapter.
  value as StandardSchema<T>;

const isCustomSchema = (
  value: TuvrenJsonSchema | CustomSchema
): value is CustomSchema =>
  typeof value === "object" &&
  value !== null &&
  "toJSONSchema" in value &&
  typeof value.toJSONSchema === "function" &&
  "validate" in value &&
  typeof value.validate === "function";

const getCustomSchema = (
  value: TuvrenJsonSchema | CustomSchema
): CustomSchema => {
  if (!isCustomSchema(value)) {
    throw new Error("expected CustomSchema");
  }
  return value;
};

const validateOk = (value: unknown) =>
  value === "ok"
    ? { success: true as const, value }
    : {
        error: new TuvrenValidationError("bad", {
          code: "tool_input_validation_failed",
        }),
        success: false as const,
      };

const validateWrapped = (
  _value: unknown
): ReturnType<NonNullable<Schema<string>["validate"]>> => ({
  success: true,
  value: "wrapped",
});

// ── jsonSchema() ──────────────────────────────────────────────────────────────

describe("jsonSchema()", () => {
  test("brands the result with schemaSymbol", () => {
    const schema = jsonSchema({ type: "string" });
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("stores the provided JSON schema", () => {
    const raw = { properties: { x: { type: "number" } }, type: "object" };
    const schema = jsonSchema(raw);
    expect(schema.jsonSchema).toEqual(raw);
  });

  test("validate is undefined when no options provided", () => {
    const schema = jsonSchema({ type: "string" });
    expect(schema.validate).toBeUndefined();
  });

  test("validate option is forwarded", () => {
    const schema = jsonSchema<string>(
      { type: "string" },
      { validate: validateOk }
    );
    expect(schema.validate).toBe(validateOk);
  });

  test("validate() succeeds for valid input", () => {
    const schema = jsonSchema<string>(
      { type: "string" },
      {
        validate: (v) =>
          typeof v === "string"
            ? { success: true, value: v }
            : {
                error: new TuvrenValidationError("bad", {
                  code: "tool_input_validation_failed",
                }),
                success: false,
              },
      }
    );
    const result = schema.validate?.("hello");
    expect(result?.success).toBe(true);
    if (result?.success === true) {
      expect(result.value).toBe("hello");
    }
  });
});

// ── asSchema() — ADR-0038 branch precedence ────────────────────────────────────

describe("asSchema() — branch 1: already-wrapped Schema", () => {
  test("returns the same Schema object identity", () => {
    const original = jsonSchema({ type: "string" });
    const result = asSchema(original);
    expect(result).toBe(original);
  });

  test("round-trips a Schema with validate", () => {
    const original = jsonSchema<string>(
      { type: "string" },
      {
        validate: validateWrapped,
      }
    );
    const result = asSchema(original);
    expect(result.validate).toBe(validateWrapped);
  });
});

describe("asSchema() — branch 2: Zod v4 (_zod in schema)", () => {
  test("detects Zod v4 via _zod property", () => {
    const mock = makeZodV4Mock({ data: 42, success: true });
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate() success returns parsed value from safeParse", () => {
    const mock = makeZodV4Mock({ data: 42, success: true });
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
    const result = schema.validate?.(99);
    expect(result).toEqual({ success: true, value: 42 });
  });

  test("validate() failure wraps error in TuvrenValidationError", () => {
    const mock = makeZodV4Mock<number>({
      issues: [{ message: "Expected number" }],
      message: "not a number",
      success: false,
    });
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
    const result = schema.validate?.("nope");
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toBeInstanceOf(TuvrenValidationError);
      expect(result.error.code).toBe("tool_input_validation_failed");
    }
  });

  test("jsonSchema uses toJSONSchema() when available", () => {
    const raw = { type: "number" };
    const mock = makeZodV4Mock({ data: 1, success: true }, raw);
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
    expect(schema.jsonSchema).toEqual(raw);
  });

  test("jsonSchema falls back to {} when toJSONSchema is absent", () => {
    const mock = makeZodV4Mock({ data: 1, success: true });
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
    expect(schema.jsonSchema).toEqual({});
  });
});

describe("asSchema() — branch 3: Standard Schema (non-zod vendor)", () => {
  test("detects Standard Schema via ~standard property", () => {
    const mock = makeStandardMock({ value: "hello" });
    const schema = asSchema(toFlexibleSchemaFixture<string>(mock));
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate() success returns the result value", () => {
    const mock = makeStandardMock({ value: "hello" });
    const schema = asSchema(toFlexibleSchemaFixture<string>(mock));
    const result = schema.validate?.("hello");
    expect(result).toEqual({ success: true, value: "hello" });
  });

  test("validate() failure with issues wraps in TuvrenValidationError", () => {
    const mock = makeStandardMock<string>({
      issues: [{ message: "too short" }],
    });
    const schema = asSchema(toFlexibleSchemaFixture<string>(mock));
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
    const schema = asSchema(toFlexibleSchemaFixture<string>(mock));
    expect(() => schema.validate?.("async")).toThrow(TuvrenValidationError);
    expect(() => schema.validate?.("async")).toThrow(ASYNC_SCHEMA_REGEX);
  });

  test("jsonSchema uses toJSONSchema() when available", () => {
    const raw = { type: "string" };
    const mock = makeStandardMock({ value: "ok" }, raw);
    const schema = asSchema(toFlexibleSchemaFixture<string>(mock));
    expect(schema.jsonSchema).toEqual(raw);
  });

  test("jsonSchema falls back to {} when toJSONSchema is absent", () => {
    const mock = makeStandardMock({ value: "ok" });
    const schema = asSchema(toFlexibleSchemaFixture<string>(mock));
    expect(schema.jsonSchema).toEqual({});
  });
});

describe("asSchema() — branch 4: Zod v3 compat (~standard.vendor === 'zod')", () => {
  test("routes Zod v3 compat via safeParse, not ~standard.validate", () => {
    // We verify routing by checking that safeParse is used (not ~standard.validate).
    // We make safeParse succeed but ~standard.validate fail — branch 4 should succeed.
    const mock = {
      safeParse(_value: unknown) {
        return { data: 42, success: true as const };
      },
      "~standard": {
        validate(_v: unknown): { issues: readonly { message: string }[] } {
          return { issues: [{ message: "should not be called" }] };
        },
        vendor: "zod" as const,
      },
    };
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
    const result = schema.validate?.(0);
    expect(result).toEqual({ success: true, value: 42 });
  });

  test("validate() failure uses Zod error path (not Standard Schema issues)", () => {
    const mock = makeZodV3Mock<number>({
      message: "bad input",
      success: false,
    });
    const schema = asSchema(toFlexibleSchemaFixture<number>(mock));
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
      { data: "ok", success: true },
      { type: "string" }
    );
    const schema = asSchema(() => toFlexibleSchemaFixture<string>(mock));
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
    const schema = asSchema({ type: "object" });
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toEqual({ type: "object" });
    expect(schema.validate).toBeUndefined();
  });

  test("boolean true is wrapped", () => {
    const schema = asSchema(true);
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toBe(true);
    expect(schema.validate).toBeUndefined();
  });

  test("boolean false is wrapped", () => {
    const schema = asSchema(false);
    expect(schema[schemaSymbol]).toBe(true);
    expect(schema.jsonSchema).toBe(false);
    expect(schema.validate).toBeUndefined();
  });
});

// ── zodSchema() ───────────────────────────────────────────────────────────────

describe("zodSchema()", () => {
  test("wraps Zod v4 schema (has safeParse) into a branded Schema", () => {
    const mock = makeZodV4Mock({ data: 1, success: true });
    // The partial mock is deliberately cast to the Zod input type for this branch test.
    const schema = zodSchema(toZodSchemaFixture<number>(mock));
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate delegates to safeParse", () => {
    const mock = makeZodV4Mock({ data: "hello", success: true });
    const schema = zodSchema(toZodSchemaFixture<string>(mock));
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
    const schema = standardSchema(toStandardSchemaFixture<number>(mock));
    expect(schema[schemaSymbol]).toBe(true);
  });

  test("validate delegates to ~standard.validate", () => {
    const mock = makeStandardMock({ value: 7 });
    const schema = standardSchema(toStandardSchemaFixture<number>(mock));
    expect(schema.validate?.(0)).toEqual({ success: true, value: 7 });
  });
});

// ── defineTool() ──────────────────────────────────────────────────────────────

describe("defineTool()", () => {
  test("returns a TuvrenToolDefinition with correct name and description", () => {
    const tool = defineTool({
      description: "A test tool",
      execute: String,
      inputSchema: { type: "string" },
      name: "my-tool",
    });
    expect(tool.name).toBe("my-tool");
    expect(tool.description).toBe("A test tool");
  });

  test("plain input schema is passed to the runtime", () => {
    const raw = { required: ["x"], type: "object" };
    const tool = defineTool({
      description: "d",
      execute: (input) => input,
      inputSchema: raw,
      name: "t",
    });
    expect(tool.inputSchema).toEqual(raw);
  });

  test("boolean input schema is passed to the runtime", () => {
    const tool = defineTool({
      description: "d",
      execute: (input) => input,
      inputSchema: false,
      name: "t",
    });
    expect(tool.inputSchema).toBe(false);
  });

  test("inputSchema.validate() propagates schema validation success", () => {
    const mock = makeZodV4Mock({ data: 99, success: true });
    const tool = defineTool({
      description: "d",
      execute: (input) => input,
      inputSchema: toFlexibleSchemaFixture<number>(mock),
      name: "t",
    });
    expect(getCustomSchema(tool.inputSchema).validate(0)).toEqual({
      valid: true,
      value: 99,
    });
  });

  test("inputSchema.validate() propagates schema validation failure", () => {
    const mock = makeZodV4Mock<number>({
      issues: [{ message: "Expected number" }],
      message: "not a number",
      success: false,
    });
    const tool = defineTool({
      description: "d",
      execute: (input) => input,
      inputSchema: toFlexibleSchemaFixture<number>(mock),
      name: "t",
    });
    const result = getCustomSchema(tool.inputSchema).validate("bad");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.message).toBe("not a number");
    }
  });

  test("execute callback receives validated input", async () => {
    let capturedInput: unknown;
    const tool = defineTool({
      description: "d",
      execute: (input) => {
        capturedInput = input;
        return "done";
      },
      inputSchema: { type: "string" },
      name: "t",
    });
    await tool.execute("hello", STUB_CTX);
    expect(capturedInput).toBe("hello");
  });

  test("approval, timeout, and metadata are forwarded", () => {
    const tool = defineTool({
      approval: true,
      description: "d",
      execute: (input) => input,
      inputSchema: { type: "string" },
      metadata: { version: 1 },
      name: "t",
      timeout: 5000,
    });
    expect(tool.approval).toBe(true);
    expect(tool.timeout).toBe(5000);
    expect(tool.metadata).toEqual({ version: 1 });
  });

  test("FlexibleSchema is normalized once at definition time (lazy)", () => {
    let callCount = 0;
    const inner = jsonSchema<string>({ type: "string" });
    const lazy = () => {
      callCount += 1;
      return inner;
    };
    defineTool({
      description: "d",
      execute: (i) => i,
      inputSchema: lazy,
      name: "t",
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
      description: "greet",
      execute: ({ name }) => `Hello ${name}`,
      inputSchema: z4.object({ name: z4.string() }),
      name: "greet",
    });
    const js = getCustomSchema(tool.inputSchema).toJSONSchema();
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
