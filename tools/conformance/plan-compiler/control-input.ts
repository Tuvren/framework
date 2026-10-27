import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { CatalogOperation } from "./certification-rules.js";

type JsonSchema = boolean | Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const encoding: unknown = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../schemas/conformance-observation-encoding.schema.json"
    ),
    "utf-8"
  )
);
if (!isRecord(encoding)) {
  throw new Error("invalid observation encoding schema");
}
ajv.addSchema(encoding);
const validators = new Map<string, ValidateFunction>();

export const controlConsumesInstance = (
  operation: CatalogOperation | undefined
): boolean =>
  operation?.kind === "control" &&
  operation.handles?.consumes?.includes("instance") === true &&
  isRecord(operation.input) &&
  Array.isArray(operation.input.required) &&
  operation.input.required.includes("instance");

const projectedSchema = (schema: JsonSchema, value: unknown): JsonSchema => {
  if (isRecord(value) && typeof value.$ref === "string") {
    return true;
  }
  if (!(isRecord(schema) && isRecord(value) && isRecord(schema.properties))) {
    return schema;
  }
  const properties = { ...schema.properties };
  for (const [key, child] of Object.entries(value)) {
    const field = properties[key];
    if (typeof field === "boolean" || isRecord(field)) {
      properties[key] = projectedSchema(field, child);
    }
  }
  return { ...schema, properties };
};

const unwrapLiterals = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(unwrapLiterals);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (Object.hasOwn(value, "$literal")) {
    return value.$literal;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, unwrapLiterals(child)])
  );
};

export const operationInputProblem = (
  operation: CatalogOperation | undefined,
  input: unknown,
  projected = false
): string | undefined => {
  if (operation?.input === undefined) {
    return undefined;
  }
  const value = projected ? unwrapLiterals(input) : input;
  const schema = projected
    ? projectedSchema(operation.input, input)
    : operation.input;
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    validators.set(key, validate);
  }
  return validate(value)
    ? undefined
    : `${operation.operationId} arguments: ${ajv.errorsText(validate.errors)}`;
};

export const controlInputProblem = (
  operation: CatalogOperation | undefined,
  input: unknown,
  projected = false
): string | undefined =>
  operation?.kind === "control"
    ? operationInputProblem(operation, input, projected)
    : undefined;
