import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { ConformancePlanAssertion } from "../../plan-compiler/index.js";
import type { AssertionContext } from "./index.js";
import { readPath } from "./path.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Compile each distinct schema once per process instead of once per
// schemaValid assertion (KRT-BM004; audit finding [C-02]). Schemas arrive as
// fixture-embedded values without a reliable `$id`, and the same logical
// schema is re-read as a fresh object per plan/fixture load — so reference
// identity is NOT a safe cache key. Key by content (stable JSON) instead:
// two structurally identical schemas share a compiled validator, and two
// distinct schemas can never collide. Mirrors the memoization pattern in
// typescript/runtime/src/lib/tool-execution-helpers.ts.
const schemaValidatorCache = new Map<string, ValidateFunction>();

// JSON.stringify is key-order sensitive, so serialize with sorted object
// keys: the same schema loaded from differently-ordered JSON still hits one
// cache entry, while any semantic difference changes the key. The rebuilt
// object uses own data properties so a literal "__proto__" property name lands as
// an own property instead of vanishing through the inherited setter — with
// a plain {} two schemas differing only in a "__proto__" member would
// serialize identically and collide.
const canonicalSchemaKey = (value: unknown): string =>
  JSON.stringify(value, (_key, node: unknown) => {
    if (isRecord(node)) {
      return Object.fromEntries(
        Object.keys(node)
          .toSorted()
          .map((key) => [key, node[key]])
      );
    }
    return node;
  });

// Exported for the assertion-engine unit tests (memoization identity and
// collision-safety assertions); production callers go through
// assertSchemaValid.
export const getCompiledSchemaValidator = (
  schema: AnySchema
): ValidateFunction => {
  const key = canonicalSchemaKey(schema);
  const cached = schemaValidatorCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  // schemaValid is synchronous; reject Ajv's async validators before caching.
  if ("$async" in validate && validate.$async) {
    throw new Error(
      "schemaValid assertion does not support asynchronous schemas"
    );
  }

  schemaValidatorCache.set(key, validate);
  return validate;
};

const readJsonSchema = (
  value: unknown,
  label: string
): boolean | Record<string, unknown> => {
  if (typeof value === "boolean" || isRecord(value)) {
    return value;
  }

  throw new Error(`${label} must contain a JSON Schema object or boolean`);
};

export const assertSchemaValid = (
  assertion: ConformancePlanAssertion,
  context: AssertionContext
): boolean => {
  if (assertion.schema === undefined) {
    throw new Error("schemaValid assertion requires schema");
  }

  const value = readPath(context, assertion.path ?? "$.result");
  const schema = readPath(context, assertion.schema);
  const validate = getCompiledSchemaValidator(
    readJsonSchema(schema, assertion.schema)
  );
  return validate(value);
};
