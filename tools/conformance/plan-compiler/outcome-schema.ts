const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const exactRequired = (value: unknown, keys: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === keys.length &&
  keys.every((key) => value.includes(key));

export const isDeclaredErrorOutcomeSchema = (
  value: unknown,
  allowedErrors: readonly string[]
): boolean => {
  if (
    !(
      object(value) &&
      exactKeys(value, ["type", "required", "properties"]) &&
      value.type === "object" &&
      exactRequired(value.required, ["kind", "error"]) &&
      object(value.properties) &&
      exactKeys(value.properties, ["kind", "error"])
    )
  ) {
    return false;
  }
  const { kind, error } = value.properties;
  if (
    !(
      object(kind) &&
      exactKeys(kind, ["const"]) &&
      kind.const === "error" &&
      object(error) &&
      exactKeys(error, ["type", "required", "properties"]) &&
      error.type === "object" &&
      exactRequired(error.required, ["code"]) &&
      object(error.properties) &&
      exactKeys(error.properties, ["code"])
    )
  ) {
    return false;
  }
  const code = error.properties.code;
  return (
    object(code) &&
    exactKeys(code, ["const"]) &&
    typeof code.const === "string" &&
    allowedErrors.includes(code.const)
  );
};

export const resolveExpectedSchema = (
  fixture: unknown,
  path: string | undefined
): unknown => {
  if (path === undefined || !path.startsWith("$.fixture.expected.")) {
    return undefined;
  }
  let value: unknown = fixture;
  for (const key of path.slice("$.fixture.".length).split(".")) {
    if (!(object(value) && Object.hasOwn(value, key))) {
      return undefined;
    }
    value = value[key];
  }
  return value;
};
