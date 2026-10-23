const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const valuesAreEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => valuesAreEqual(entry, right[index]))
    );
  }

  if (isRecord(left) || isRecord(right)) {
    if (!(isRecord(left) && isRecord(right))) {
      return false;
    }

    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();

    // JSON object field order is language-specific, so equality is structural
    // and key-order independent across TypeScript/Rust adapter observations.
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && valuesAreEqual(left[key], right[key])
      )
    );
  }

  return false;
};
