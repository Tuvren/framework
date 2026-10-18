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

import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv from "ajv";

import { normalizeError } from "./tool-execution-helpers.js";

/** Shared Ajv instance for JSON Schema input/output validation. */
const ajv = new Ajv({
  allErrors: true,
  strict: false,
});
/** Memoized compiled validators, keyed by schema object identity. */
const validatorCache = new WeakMap<object, ValidateFunction>();

/**
 * Compiles a JSON Schema with the module's shared Ajv instance, memoizing
 * object schemas in a `WeakMap` so each tool schema compiles at most once.
 * Boolean schemas (valid JSON Schema) are compiled fresh since they cannot
 * key a WeakMap.
 */
const getCompiledValidator = (
  schema: TuvrenToolDefinition["inputSchema"]
): ValidateFunction => {
  if (typeof schema === "boolean") {
    return ajv.compile(schema);
  }

  const cached = validatorCache.get(schema);

  if (cached !== undefined) {
    return cached;
  }

  const validator = ajv.compile(schema);
  validatorCache.set(schema, validator);
  return validator;
};

/**
 * Projects Ajv error objects to a stable, serializable diagnostic shape for
 * validation-failure `output.details`.
 */
const formatAjvErrors = (errors: ErrorObject[] | null | undefined): unknown =>
  errors?.map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message,
    params: error.params,
    schemaPath: error.schemaPath,
  }));

/**
 * Validates a tool's output value against its declared `outputSchema`
 * (AX001).
 *
 * Supports both schema flavors from framework spec §8.2: a custom schema
 * object exposing `validate()` (whose returned `value` may be a coerced or
 * transformed copy), or a plain JSON Schema compiled with Ajv (in which case
 * `value` is the input untouched). A `validate()` implementation that throws
 * is reported as a validation failure, not an execution error.
 *
 * @returns `{ valid: true, value }` with the value to forward, or
 *   `{ valid: false, details }` with validator diagnostics.
 */
export const validateToolOutput = (
  schema: NonNullable<TuvrenToolDefinition["outputSchema"]>,
  output: unknown
):
  | { details?: unknown; valid: true; value: unknown }
  | { details?: unknown; valid: false } => {
  if (
    schema !== null &&
    typeof schema === "object" &&
    "validate" in schema &&
    typeof schema.validate === "function"
  ) {
    let result: ReturnType<typeof schema.validate>;

    try {
      result = schema.validate(output);
    } catch (error: unknown) {
      return {
        details: { error: normalizeError(error).message },
        valid: false,
      };
    }

    return result.valid
      ? { valid: true, value: result.value }
      : { details: result.error, valid: false };
  }

  const validator = getCompiledValidator(schema);
  const valid = validator(output);

  if (valid) {
    return { valid: true, value: output };
  }

  return { details: formatAjvErrors(validator.errors), valid: false };
};

/**
 * Validates a tool-call input against the tool's `inputSchema` (framework
 * spec §8.6 step 2; re-run on the resume path for `edit` decisions).
 *
 * Same dual-flavor semantics as {@link validateToolOutput}: custom
 * `validate()` schemas may return a coerced `value`, Ajv-compiled JSON
 * Schemas return the original input. Compiled validators are cached per
 * schema object (see `getCompiledValidator`), so repeated invocations of the
 * same tool do not recompile.
 *
 * @returns `{ valid: true, value }` with the value the tool should execute
 *   with, or `{ valid: false, details }` with validator diagnostics.
 */
export const validateToolInput = (
  tool: TuvrenToolDefinition,
  input: unknown
):
  | { details?: unknown; valid: true; value: unknown }
  | { details?: unknown; valid: false } => {
  const schema = tool.inputSchema;

  if (
    schema !== null &&
    typeof schema === "object" &&
    "validate" in schema &&
    typeof schema.validate === "function"
  ) {
    let result: ReturnType<typeof schema.validate>;

    try {
      result = schema.validate(input);
    } catch (error: unknown) {
      return {
        details: {
          error: normalizeError(error).message,
        },
        valid: false,
      };
    }

    return result.valid
      ? { valid: true, value: result.value }
      : { details: result.error, valid: false };
  }

  const validator = getCompiledValidator(schema);
  const valid = validator(input);

  if (valid) {
    return {
      valid: true,
      value: input,
    };
  }

  return {
    details: formatAjvErrors(validator.errors),
    valid: false,
  };
};
