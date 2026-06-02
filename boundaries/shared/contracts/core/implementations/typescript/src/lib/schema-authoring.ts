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

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ApprovalPolicy,
  CustomSchema,
  ToolExecutionContext,
  TuvrenJsonSchema,
  TuvrenToolDefinition,
  ValidationResult,
} from "./runtime-contract-shapes.js";
import { TuvrenValidationError } from "./tuvren-error.js";

// ── Branded symbol ─────────────────────────────────────────────────────────

export const schemaSymbol = Symbol.for("tuvren.schema");

// ── Schema types (ADR-038) ─────────────────────────────────────────────────

/** Normalized schema wrapper carrying JSON schema + optional validate. */
export interface Schema<T = unknown> {
  readonly _type: T; // brand only; never read at runtime
  readonly jsonSchema: TuvrenJsonSchema;
  readonly validate?: (
    value: unknown
  ) =>
    | { success: true; value: T }
    | { success: false; error: TuvrenValidationError };
  readonly [schemaSymbol]: true;
}

/**
 * Zod v3 compat (from zod@4.x/v3) and Zod v4 native schema types.
 * Both ship in zod@4.x; zod/v3 is the backward-compat surface.
 */
export type ZodSchema<T = unknown> =
  | import("zod/v3").Schema<T, import("zod/v3").ZodTypeDef, unknown>
  | import("zod/v4").ZodType<T>;

/** Standard Schema (https://github.com/standard-schema/standard-schema) */
export type StandardSchema<T = unknown> = StandardSchemaV1<unknown, T>;

/** Lazy schema — a zero-arg function returning any FlexibleSchema (including another lazy). */
export type LazySchema<T = unknown> = () => FlexibleSchema<T>;

/**
 * Union of all supported input schema authoring shapes. Passed to
 * `asSchema()` or directly to `defineTool`'s `inputSchema` field.
 * The bare `TuvrenJsonSchema` path produces `INPUT = unknown` in
 * `defineTool`'s execute callback.
 */
export type FlexibleSchema<T = unknown> =
  | Schema<T>
  | ZodSchema<T>
  | StandardSchema<T>
  | LazySchema<T>
  | TuvrenJsonSchema; // legacy bare-JSON-Schema path; T = unknown

// ── Structural duck-types for the two library-backed paths ─────────────────
// These are proper structural supertypes: ZodSchema<T> and StandardSchema<T>
// are both assignable to these interfaces, so no type assertions are needed
// when passing library values to the internal factory functions.

/**
 * Structural supertype covering both Zod v3 compat and Zod v4 schemas.
 * `ZodSchema<T>` (a union of Zod v3 and v4 types) is structurally
 * assignable to `ZodLike<T>` because both members expose `safeParse`
 * with compatible return types.  `toJSONSchema` is intentionally omitted:
 * Zod v4's `toJSONSchema()` returns `ZodStandardJSONSchemaPayload<…>` whose
 * index signature is `unknown`, not `TuvrenJsonValue`, so it is not
 * assignable to `TuvrenJsonSchema`.  JSON Schema extraction is handled by
 * `extractJsonSchema` which bridges the external-library boundary.
 */
interface ZodLike<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly message?: string;
          readonly issues?: unknown;
        };
      };
}

/**
 * Structural supertype for Standard Schema-compliant objects.
 * `StandardSchema<T>` (= `StandardSchemaV1<unknown, T>`) is structurally
 * assignable here because the validate return type is covariant in T.
 * `toJSONSchema` is omitted for the same reason as in `ZodLike`.
 */
interface StandardLike<T> {
  readonly "~standard": {
    readonly vendor?: string;
    validate(value: unknown):
      | { readonly value: T; readonly issues?: undefined }
      | {
          readonly value?: undefined;
          readonly issues: ReadonlyArray<{ readonly message: string }>;
        }
      | Promise<
          | { readonly value: T; readonly issues?: undefined }
          | {
              readonly value?: undefined;
              readonly issues: ReadonlyArray<{ readonly message: string }>;
            }
        >;
  };
}

// ── Adapter helpers (public API) ───────────────────────────────────────────

/**
 * Wraps a bare `TuvrenJsonSchema` with the Tuvren schema brand.
 * Optionally accepts a validate function for runtime input checking.
 */
export function jsonSchema<T = unknown>(
  schema: TuvrenJsonSchema,
  options?: { validate?: Schema<T>["validate"] }
): Schema<T> {
  return {
    // `schemaSymbol` is Symbol.for("tuvren.schema"); `true as const` gives
    // the branded literal type required by Schema<T>.
    [schemaSymbol]: true as const,
    // _type is a phantom brand never read at runtime.  TypeScript requires a
    // value of type T here; `undefined` is the only safe choice that adds no
    // runtime overhead.  This is the single, intentional phantom-brand
    // assignment in the file.
    _type: undefined as T,
    jsonSchema: schema,
    validate: options?.validate,
  };
}

/**
 * Wraps a Zod schema (v3 compat or v4 native) into a `Schema<T>`.
 * JSON Schema is extracted via `toJSONSchema()` when available (Zod v4).
 * Zod v3 compat schemas fall back to `{}` since they have no built-in
 * JSON Schema generator; validation still uses `safeParse`.
 */
export function zodSchema<T>(schema: ZodSchema<T>): Schema<T> {
  // ZodSchema<T> is structurally assignable to ZodLike<T>: both Zod v3 compat
  // and Zod v4 types have safeParse with compatible signatures and optionally
  // toJSONSchema.  No type assertion is needed here.
  return buildZodSchema<T>(schema);
}

/**
 * Wraps a Standard Schema-compliant object into a `Schema<T>`.
 * JSON Schema is extracted via `toJSONSchema()` when available.
 * Validation uses the Standard Schema `~standard.validate` method.
 * Async validate functions throw `TuvrenValidationError` immediately;
 * tool execute contexts are synchronous.
 */
export function standardSchema<T>(schema: StandardSchema<T>): Schema<T> {
  // StandardSchema<T> is structurally assignable to StandardLike<T>.  No type
  // assertion needed.
  return buildStandardSchema<T>(schema);
}

// ── asSchema — centralized 6-branch normalizer (ADR-038) ──────────────────

/**
 * Normalizes any `FlexibleSchema<T>` into a branded `Schema<T>`.
 *
 * Precedence (ADR-038):
 *   1. Already-wrapped   — schemaSymbol in schema
 *   2. Zod v4            — _zod in schema
 *   3. Standard non-zod  — ~standard in schema && vendor !== "zod"
 *   4. Standard zod      — ~standard in schema && vendor === "zod"  (Zod v3)
 *   5. Lazy function     — typeof schema === "function"
 *   6. Bare JSON Schema  — fallback; T = unknown
 */
export function asSchema<T>(schema: FlexibleSchema<T>): Schema<T> {
  // Branches 1–4 and the object-shape branch 6 require an object value.
  if (typeof schema === "object" && schema !== null) {
    // Branch 1: already-wrapped (schemaSymbol in schema).
    // The union member Schema<T> has [schemaSymbol]: true, so after this
    // check we can safely return the value typed as Schema<T>.
    if (schemaSymbol in schema) {
      // Only Schema<T> declares [schemaSymbol]; the `as` is a sound identity
      // passthrough — no re-wrapping needed.
      return schema as Schema<T>;
    }

    // Branch 2: Zod v4 — all Zod v4 schemas carry an `_zod` internals bag.
    if ("_zod" in schema) {
      return buildZodSchema<T>(schema as ZodLike<T>);
    }

    // Branches 3 & 4: the `~standard` property marks a Standard Schema.
    if ("~standard" in schema) {
      const std = schema as StandardLike<T>;
      if (std["~standard"].vendor === "zod") {
        // Branch 4: Zod v3 compat implements Standard Schema with vendor
        // "zod" but has no `_zod` bag.  Use Zod path via safeParse.
        return buildZodSchema<T>(schema as ZodLike<T>);
      }
      // Branch 3: genuine non-zod Standard Schema.
      return buildStandardSchema<T>(std);
    }

    // Branch 6 (object form): bare TuvrenJsonSchema.
    return jsonSchema<T>(schema as TuvrenJsonSchema);
  }

  // Branch 5: lazy function — recurse once into the returned value.
  if (typeof schema === "function") {
    return asSchema<T>(schema());
  }

  // Branch 6 (boolean form): bare TuvrenJsonSchema (true / false).
  return jsonSchema<T>(schema);
}

// ── defineTool ─────────────────────────────────────────────────────────────

/**
 * Defines a typed tool whose `inputSchema` is normalized once at
 * definition time via `asSchema`. Returns a `TuvrenToolDefinition`
 * whose `inputSchema` satisfies the `CustomSchema` boundary contract.
 *
 * `OUTPUT` is inferred from `execute`'s return type but is not carried
 * into the unparameterized `TuvrenToolDefinition` return type.  It is
 * reserved for a forthcoming typed-definition surface.
 */
export function defineTool<INPUT, OUTPUT>(options: {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<INPUT>;
  execute: (
    input: INPUT,
    context: ToolExecutionContext
  ) => Promise<OUTPUT> | OUTPUT;
  approval?: ApprovalPolicy;
  idempotent?: boolean;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
  /**
   * Declared result shape for output validation. Accepts a plain JSON Schema
   * (AJV-validated) or a CustomSchema with a custom validate function. When
   * omitted, output is not validated. See TuvrenToolDefinition.outputSchema.
   */
  outputSchema?: TuvrenJsonSchema | CustomSchema;
  timeout?: number;
}): TuvrenToolDefinition {
  const normalized = asSchema(options.inputSchema);
  const userExecute = options.execute;

  const customSchema: CustomSchema = {
    toJSONSchema(): TuvrenJsonSchema {
      return normalized.jsonSchema;
    },
    validate(input: unknown): ValidationResult {
      if (normalized.validate === undefined) {
        return { valid: true, value: input };
      }
      const result = normalized.validate(input);
      if (result.success) {
        return { valid: true, value: result.value };
      }
      return {
        valid: false,
        error: {
          details: result.error.details,
          message: result.error.message,
        },
      };
    },
  };

  return {
    approval: options.approval,
    description: options.description,
    // ExecuteFunction takes (input: unknown, ...) while userExecute takes
    // (input: INPUT, ...).  The gateway always passes the value that came
    // through inputSchema.validate, so the runtime type is INPUT even though
    // the static type is unknown.  This is the boundary assignment that
    // bridges unknown ← INPUT at the TuvrenToolDefinition contract seam.
    execute(input, context) {
      return userExecute(input as INPUT, context);
    },
    idempotent: options.idempotent,
    inputSchema: customSchema,
    maxRetries: options.maxRetries,
    metadata: options.metadata,
    name: options.name,
    outputSchema: options.outputSchema,
    timeout: options.timeout,
  };
}

// ── Internal schema builders ───────────────────────────────────────────────

/**
 * Calls `toJSONSchema()` on any schema object that exposes it, bridging the
 * external-library return type to `TuvrenJsonSchema`.  The single `as`
 * assertion at the return site is the genuine external-library boundary
 * crossing: we know `toJSONSchema()` produces a JSON-Schema-compatible
 * object, but the external type (e.g. Zod's `ZodStandardJSONSchemaPayload`)
 * uses a wider index signature than `TuvrenJsonValue` allows statically.
 */
function extractJsonSchema(schema: object): TuvrenJsonSchema {
  if (!("toJSONSchema" in schema)) {
    return {};
  }
  // `in` narrows schema to `object & { toJSONSchema: unknown }`.
  // We still need to verify callability before invoking.
  const fn = schema.toJSONSchema;
  if (typeof fn !== "function") {
    return {};
  }
  return fn.call(schema) as TuvrenJsonSchema;
}

function buildZodSchema<T>(zod: ZodLike<T>): Schema<T> {
  return {
    [schemaSymbol]: true as const,
    _type: undefined as T,
    jsonSchema: extractJsonSchema(zod),
    validate(value) {
      const result = zod.safeParse(value);
      if (result.success) {
        return { success: true, value: result.data };
      }
      return {
        success: false,
        error: new TuvrenValidationError(
          result.error.message ?? "Validation failed",
          {
            code: "tool_input_validation_failed",
            details: result.error.issues,
          }
        ),
      };
    },
  };
}

function buildStandardSchema<T>(std: StandardLike<T>): Schema<T> {
  return {
    [schemaSymbol]: true as const,
    _type: undefined as T,
    jsonSchema: extractJsonSchema(std),
    validate(value) {
      const result = std["~standard"].validate(value);

      // `instanceof Promise` narrows TypeScript's union; the `.then` guard
      // additionally catches cross-realm Promises and custom thenables that
      // slip past instanceof but are still async.
      if (
        result instanceof Promise ||
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new TuvrenValidationError(
          "Async Standard Schema validation is not supported in synchronous tool contexts",
          { code: "invalid_tool_schema_authoring" }
        );
      }

      if (result.issues !== undefined) {
        return {
          success: false,
          error: new TuvrenValidationError("Validation failed", {
            code: "tool_input_validation_failed",
            details: result.issues,
          }),
        };
      }

      return { success: true, value: result.value };
    },
  };
}
