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

import type { CustomSchema } from "@tuvren/core/tools";
import { asSchema, defineTool, jsonSchema, schemaSymbol } from "@tuvren/sdk";
import type { FlexibleSchema } from "@tuvren/sdk";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";

import type { AdapterProjection } from "./framework-adapter-runtime.ts";

// ── Input reading ─────────────────────────────────────────────────────────────

const ZOD_NUMBER_INPUT = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fromSynchronous = <Argument, Value>(
  operation: (argument: Argument) => Value
): ((argument: Argument) => Promise<Value>) =>
  Promise.try.bind<
    typeof Promise,
    [(argument: Argument) => Value],
    [Argument],
    Promise<Value>
  >(Promise, operation);

const readBranch = (input: unknown): string => {
  if (!isRecord(input)) {
    return "json-schema-object";
  }
  const { checkInput } = input;
  if (!isRecord(checkInput)) {
    return "json-schema-object";
  }
  const { branch } = checkInput;
  return typeof branch === "string" ? branch : "json-schema-object";
};

// ── Branch schema factory (ADR-0038 ordering) ──────────────────────────────────

const buildBranchSchema = (branch: string): FlexibleSchema => {
  switch (branch) {
    // Branch 1: already-wrapped Schema — identity pass-through
    case "already-wrapped": {
      return jsonSchema({ type: "string" });
    }

    // Branch 2: Zod v4 — detected via `_zod` property
    case "zod-v4": {
      return z4.number();
    }

    // Branch 3: Standard Schema (non-zod vendor)
    case "standard-non-zod": {
      return {
        "~standard": {
          validate(value: unknown) {
            return { issues: undefined, value };
          },
          vendor: "valibot",
          version: 1,
        },
      };
    }

    // Branch 4: Zod v3 compat — ADR-0038 ambiguous case.
    // ~standard.validate is rigged to fail; safeParse succeeds.
    // Correct routing via the Zod path (safeParse) produces validateSuccess: true.
    // Incorrect routing via Standard path would produce validateSuccess: false.
    case "standard-zod-v3": {
      const schema = z3.any();
      Object.defineProperty(schema["~standard"], "validate", {
        value: (_value: unknown) => ({
          issues: [{ message: "standard-path-must-not-be-taken" }],
        }),
      });
      return schema;
    }

    // Branch 5: lazy function
    case "lazy": {
      return () => jsonSchema({ type: "boolean" });
    }

    // Branch 6: bare TuvrenJsonSchema — boolean true
    case "json-schema-bool-true": {
      return true;
    }

    // Branch 6: bare TuvrenJsonSchema — boolean false
    case "json-schema-bool-false": {
      return false;
    }

    // Branch 6: bare TuvrenJsonSchema — object form (default)
    default: {
      return { type: "object" };
    }
  }
};

// ── Operation handlers ────────────────────────────────────────────────────────

const runSchemaAuthoringRouteSynchronous = (
  input: unknown
): AdapterProjection => {
  const branch = readBranch(input);
  const schema = buildBranchSchema(branch);
  const normalized = asSchema(schema);

  const jsonSchemaValue = normalized.jsonSchema;
  const jsonSchemaIsBoolean = typeof jsonSchemaValue === "boolean";
  const jsonSchemaType =
    !jsonSchemaIsBoolean &&
    typeof jsonSchemaValue === "object" &&
    jsonSchemaValue !== null
      ? (jsonSchemaValue.type ?? null)
      : null;

  const validateFn = normalized.validate;
  let validateSuccess: boolean | null = null;
  if (validateFn !== undefined) {
    const validationInput =
      branch === "zod-v4" ? ZOD_NUMBER_INPUT : "test-input";
    validateSuccess = validateFn(validationInput).success;
  }

  return {
    result: {
      schemaAuthoring: {
        hasSchemaSymbol: normalized[schemaSymbol],
        hasValidate: validateFn !== undefined,
        jsonSchemaIsBoolean,
        jsonSchemaType:
          typeof jsonSchemaType === "string" ? jsonSchemaType : null,
        jsonSchemaValue: jsonSchemaIsBoolean ? jsonSchemaValue : null,
        validateSuccess,
      },
    },
  };
};

const runSchemaAuthoringRoute = fromSynchronous(
  runSchemaAuthoringRouteSynchronous
);

const isCustomSchema = (value: unknown): value is CustomSchema =>
  isRecord(value) &&
  typeof value.toJSONSchema === "function" &&
  typeof value.validate === "function";

const runSchemaAuthoringDefineToolSynchronous = (
  _input: unknown
): AdapterProjection => {
  const tool = defineTool({
    description: "conformance test tool",
    execute: (_in) => "done",
    inputSchema: { type: "string" },
    name: "test-tool",
  });

  // defineTool always assigns a CustomSchema object to inputSchema; the wider
  // union type on TuvrenToolDefinition accommodates legacy bare-JSON-Schema
  // paths that don't go through defineTool.
  const customSchema = tool.inputSchema;
  if (!isCustomSchema(customSchema)) {
    throw new TypeError("defineTool did not normalize its input schema");
  }
  const rawJsonSchema = customSchema.toJSONSchema();
  const jsonSchemaType =
    typeof rawJsonSchema === "object" && rawJsonSchema !== null
      ? (rawJsonSchema.type ?? null)
      : null;

  const validateResult = customSchema.validate("test-input");

  return {
    result: {
      schemaAuthoring: {
        defineTool: {
          jsonSchemaType:
            typeof jsonSchemaType === "string" ? jsonSchemaType : null,
          name: tool.name,
          validateSuccess: validateResult.valid,
        },
      },
    },
  };
};

const runSchemaAuthoringDefineTool = fromSynchronous(
  runSchemaAuthoringDefineToolSynchronous
);

export const createFrameworkAdapterSchemaAuthoring = () => ({
  runSchemaAuthoringDefineTool,
  runSchemaAuthoringRoute,
});
