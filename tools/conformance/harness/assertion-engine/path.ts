const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readPath = (source: unknown, path: string): unknown => {
  if (path === "$") {
    return source;
  }

  if (!path.startsWith("$.")) {
    throw new Error(`unsupported path ${path}`);
  }

  let current = source;
  const segments = path.slice(2).split(".");

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
};
