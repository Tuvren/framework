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
import { readdirSync, readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

const CORE_SCHEMA_URL = new URL(
  "../../../spec/core/artifacts/json-schema/",
  import.meta.url
);
const HOST_SCHEMA_URL = new URL(
  "../../../spec/host/artifacts/json-schema/",
  import.meta.url
);
const SESSION_SCHEMA_URL = new URL(
  "../../../spec/host/session/artifacts/json-schema/",
  import.meta.url
);

describe("host admission-key JSON Schema contracts", () => {
  test.each([
    {
      allowedKeys: ["admissionKey", "parts", "role"],
      directory: CORE_SCHEMA_URL,
      id: "https://tuvren.dev/schemas/shared/core-types/UserMessage.json",
      name: "core UserMessage",
      value: {
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    },
    {
      allowedKeys: ["admissionKey", "parts", "role"],
      directory: HOST_SCHEMA_URL,
      id: "https://tuvren.dev/schemas/framework/runtime-api/UserMessage.json",
      name: "host UserMessage",
      value: {
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    },
    {
      allowedKeys: ["admissionKey", "parts"],
      directory: HOST_SCHEMA_URL,
      id: "https://tuvren.dev/schemas/framework/runtime-api/InputSignal.json",
      name: "host InputSignal",
      value: {
        parts: [{ text: "hello", type: "text" }],
      },
    },
    {
      allowedKeys: ["admissionKey", "parts"],
      directory: SESSION_SCHEMA_URL,
      id: "https://tuvren.dev/schemas/framework/host-session/InputSignal.json",
      name: "session InputSignal",
      value: {
        parts: [{ text: "hello", type: "text" }],
      },
    },
  ])("$name allows only an optional non-empty admissionKey", (entry) => {
    const ajv = loadJsonSchemas(entry.directory);
    const validate = ajv.getSchema(entry.id);
    const schema = readSchema(entry.directory, entry.id);

    expect(validate).toBeDefined();
    expect(schema.properties.admissionKey).toEqual({
      minLength: 1,
      type: "string",
    });
    expect(Object.keys(schema.properties).sort()).toEqual([
      ...entry.allowedKeys,
    ]);
    expect(schema.required).not.toContain("admissionKey");
    expect(validate?.(entry.value)).toBe(true);
    expect(validate?.({ ...entry.value, admissionKey: "host-key-1" })).toBe(
      true
    );
    expect(validate?.({ ...entry.value, admissionKey: "   " })).toBe(true);
    expect(validate?.({ ...entry.value, admissionKey: "" })).toBe(false);
    expect(validate?.({ ...entry.value, admissionKey: 7 })).toBe(false);
    expect(validate?.({ ...entry.value, extra: true })).toBe(false);
  });
});

interface JsonSchemaShape {
  properties: Record<string, unknown>;
  required: string[];
}

function loadJsonSchemas(directoryUrl: URL): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  for (const fileName of readdirSync(directoryUrl)) {
    if (!fileName.endsWith(".json")) {
      continue;
    }

    const schema: unknown = JSON.parse(
      readFileSync(new URL(fileName, directoryUrl), "utf8")
    );

    if (!isAjvSchema(schema)) {
      throw new Error(`${fileName} is not a JSON Schema object or boolean`);
    }

    ajv.addSchema(schema);
  }

  return ajv;
}

function isAjvSchema(value: unknown): value is AnySchema {
  return (
    typeof value === "boolean" ||
    (value !== null && typeof value === "object" && !Array.isArray(value))
  );
}

function readSchema(directoryUrl: URL, schemaId: string): JsonSchemaShape {
  const fileName = schemaId.slice(schemaId.lastIndexOf("/") + 1);
  const schema: unknown = JSON.parse(
    readFileSync(new URL(fileName, directoryUrl), "utf8")
  );

  if (
    schema === null ||
    typeof schema !== "object" ||
    !("properties" in schema) ||
    schema.properties === null ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties) ||
    !("required" in schema) ||
    !Array.isArray(schema.required) ||
    !schema.required.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`schema ${schemaId} does not have the expected shape`);
  }

  return {
    properties: Object.fromEntries(Object.entries(schema.properties)),
    required: schema.required,
  };
}
