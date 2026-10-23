import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { CatalogOperation } from "../plan-compiler/certification-rules.js";

export class ObservationEncodingError extends Error {
  override name = "ObservationEncodingError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
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
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(encoding);
const encodingId =
  "https://tuvren.dev/schemas/conformance-observation-encoding.schema.json";
const validateRecord = ajv.compile({ $ref: `${encodingId}#/$defs/record` });
const validators = new Map<string, ValidateFunction>();

const assertSchema = (
  validate: ValidateFunction,
  value: unknown,
  label: string
): void => {
  if (!validate(value)) {
    throw new ObservationEncodingError(
      `${label}: ${ajv.errorsText(validate.errors)}`
    );
  }
};

const validateMapKeys = (entries: unknown, label: string): void => {
  if (Array.isArray(entries)) {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        keys.has(entry[0])
      ) {
        throw new ObservationEncodingError(
          `${label}: map keys must be unique strings`
        );
      }
      keys.add(entry[0]);
    }
  }
};

const validateEncoding = (value: unknown, label: string): void => {
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || Object.is(value, -0))
  ) {
    throw new ObservationEncodingError(
      `${label}: expected a safe integer without negative zero`
    );
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      validateEncoding(entry, `${label}.${index}`);
    }
    return;
  }
  if (isRecord(value)) {
    if (Object.hasOwn(value, "$bytes") || Object.hasOwn(value, "$map")) {
      assertSchema(validateRecord, value, label);
    }
    validateMapKeys(value.$map, label);
    for (const [key, entry] of Object.entries(value)) {
      validateEncoding(entry, `${label}.${key}`);
    }
    return;
  }
  assertSchema(validateRecord, value, label);
};

export const validateObservation = (
  operation: CatalogOperation | undefined,
  observation: {
    events?: readonly unknown[];
    result?: unknown;
    state?: unknown;
  },
  requireResult = false
): void => {
  if (operation === undefined) {
    return;
  }
  for (const domain of ["result", "events", "state"] as const) {
    const value = observation[domain];
    if (value === undefined && !(requireResult && domain === "result")) {
      continue;
    }
    const schema = operation.observation[domain];
    if (schema === undefined) {
      if (
        (domain === "events" && Array.isArray(value) && value.length === 0) ||
        (domain === "state" && value === null)
      ) {
        continue;
      }
      throw new ObservationEncodingError(
        `${operation.operationId} does not declare ${domain}`
      );
    }
    validateEncoding(value, `${operation.operationId}.${domain}`);
    const key = JSON.stringify(schema);
    let validate = validators.get(key);
    if (validate === undefined) {
      validate = ajv.compile(schema);
      validators.set(key, validate);
    }
    assertSchema(validate, value, `${operation.operationId}.${domain}`);
  }
};

const TOKEN =
  /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]:,]|true|false|null/gu;
const NUMBER =
  /^-?(?<whole>\d+)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?$/u;

const assertIntegerToken = (token: string): void => {
  const number = Number(token);
  const groups = NUMBER.exec(token)?.groups;
  if (
    groups === undefined ||
    !Number.isSafeInteger(number) ||
    Object.is(number, -0)
  ) {
    throw new ObservationEncodingError(
      `noncanonical integer in adapter frame: ${token}`
    );
  }
  const fraction = groups.fraction ?? "";
  const digits = `${groups.whole}${fraction}`;
  const places = fraction.length - Number(groups.exponent ?? "0");
  if (places > 0 && /[1-9]/u.test(digits.slice(-places))) {
    throw new ObservationEncodingError(
      `fractional integer in adapter frame: ${token}`
    );
  }
};

/** Inspect tokens before JSON.parse discards repeated keys or rounds numbers. */
export const assertLosslessFrame = (text: string): void => {
  const stack: (Set<string> | null)[] = [];
  let previous = "";
  for (const match of text.matchAll(TOKEN)) {
    const [token] = match;
    if (token === "{") {
      stack.push(new Set());
    } else if (token === "[") {
      stack.push(null);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (
      token.startsWith('"') &&
      (previous === "{" || previous === ",")
    ) {
      const keys = stack.at(-1);
      if (keys !== undefined && keys !== null) {
        const key: unknown = JSON.parse(token);
        if (typeof key !== "string") {
          throw new ObservationEncodingError("invalid object key");
        }
        if (keys.has(key)) {
          throw new ObservationEncodingError(
            `duplicate object key in adapter frame: ${key}`
          );
        }
        keys.add(key);
      }
    } else if (NUMBER.test(token)) {
      assertIntegerToken(token);
    }
    previous = token;
  }
};
