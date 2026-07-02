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
import {
  asSchema,
  defineTool,
  type FlexibleSchema,
  jsonSchema,
  schemaSymbol,
} from "@tuvren/sdk";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

export function createFrameworkAdapterSchemaAuthoring() {
  return { runSchemaAuthoringRoute, runSchemaAuthoringDefineTool };
}

// ── Input reading ─────────────────────────────────────────────────────────────

function readBranch(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return "json-schema-object";
  }
  const checkInput = (input as Record<string, unknown>).checkInput;
  if (typeof checkInput !== "object" || checkInput === null) {
    return "json-schema-object";
  }
  const branch = (checkInput as Record<string, unknown>).branch;
  return typeof branch === "string" ? branch : "json-schema-object";
}

// ── Operation handlers ────────────────────────────────────────────────────────

function runSchemaAuthoringRoute(input: unknown): Promise<AdapterProjection> {
  const branch = readBranch(input);
  const schema = buildBranchSchema(branch);
  const normalized = asSchema(schema);

  const jsonSchemaValue = normalized.jsonSchema;
  const jsonSchemaIsBoolean = typeof jsonSchemaValue === "boolean";
  const jsonSchemaType =
    !jsonSchemaIsBoolean &&
    typeof jsonSchemaValue === "object" &&
    jsonSchemaValue !== null
      ? ((jsonSchemaValue as Record<string, unknown>).type ?? null)
      : null;

  const validateFn = normalized.validate;
  let validateSuccess: boolean | null = null;
  if (validateFn !== undefined) {
    validateSuccess = validateFn("test-input").success;
  }

  return Promise.resolve({
    result: {
      schemaAuthoring: {
        hasSchemaSymbol: normalized[schemaSymbol] === true,
        jsonSchemaIsBoolean,
        jsonSchemaType:
          typeof jsonSchemaType === "string" ? jsonSchemaType : null,
        jsonSchemaValue: jsonSchemaIsBoolean ? jsonSchemaValue : null,
        hasValidate: validateFn !== undefined,
        validateSuccess,
      },
    },
  });
}

function runSchemaAuthoringDefineTool(
  _input: unknown
): Promise<AdapterProjection> {
  const tool = defineTool({
    name: "test-tool",
    description: "conformance test tool",
    inputSchema: { type: "string" },
    execute: (_in) => "done",
  });

  // defineTool always assigns a CustomSchema object to inputSchema; the wider
  // union type on TuvrenToolDefinition accommodates legacy bare-JSON-Schema
  // paths that don't go through defineTool.
  const customSchema = tool.inputSchema as CustomSchema;
  const rawJsonSchema = customSchema.toJSONSchema();
  const jsonSchemaType =
    typeof rawJsonSchema === "object" && rawJsonSchema !== null
      ? ((rawJsonSchema as Record<string, unknown>).type ?? null)
      : null;

  const validateResult = customSchema.validate("test-input");

  return Promise.resolve({
    result: {
      schemaAuthoring: {
        defineTool: {
          name: tool.name,
          jsonSchemaType:
            typeof jsonSchemaType === "string" ? jsonSchemaType : null,
          validateSuccess: validateResult.valid,
        },
      },
    },
  });
}

// ── Branch schema factory (ADR-038 ordering) ──────────────────────────────────

function buildBranchSchema(branch: string): FlexibleSchema<unknown> {
  switch (branch) {
    // Branch 1: already-wrapped Schema — identity pass-through
    case "already-wrapped":
      return jsonSchema<unknown>({ type: "string" });

    // Branch 2: Zod v4 — detected via `_zod` property
    case "zod-v4":
      return {
        _zod: {},
        safeParse(value: unknown) {
          return { success: true as const, data: value };
        },
        toJSONSchema() {
          return { type: "number" };
        },
      } as unknown as FlexibleSchema<unknown>;

    // Branch 3: Standard Schema (non-zod vendor)
    case "standard-non-zod":
      return {
        "~standard": {
          vendor: "valibot",
          validate(value: unknown) {
            return { value, issues: undefined as undefined };
          },
        },
      } as unknown as FlexibleSchema<unknown>;

    // Branch 4: Zod v3 compat — ADR-038 ambiguous case.
    // ~standard.validate is rigged to fail; safeParse succeeds.
    // Correct routing via the Zod path (safeParse) produces validateSuccess: true.
    // Incorrect routing via Standard path would produce validateSuccess: false.
    case "standard-zod-v3":
      return {
        "~standard": {
          vendor: "zod",
          validate(_value: unknown) {
            return {
              issues: [{ message: "standard-path-must-not-be-taken" }],
            };
          },
        },
        safeParse(value: unknown) {
          return { success: true as const, data: value };
        },
      } as unknown as FlexibleSchema<unknown>;

    // Branch 5: lazy function
    case "lazy":
      return (() =>
        jsonSchema<unknown>({ type: "boolean" })) as FlexibleSchema<unknown>;

    // Branch 6: bare TuvrenJsonSchema — boolean true
    case "json-schema-bool-true":
      return true as unknown as FlexibleSchema<unknown>;

    // Branch 6: bare TuvrenJsonSchema — boolean false
    case "json-schema-bool-false":
      return false as unknown as FlexibleSchema<unknown>;

    // Branch 6: bare TuvrenJsonSchema — object form (default)
    default:
      return { type: "object" } as FlexibleSchema<unknown>;
  }
}
