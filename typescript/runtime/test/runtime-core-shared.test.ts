import { expect, test } from "bun:test";

import { cloneSnapshotPreservingFunctions } from "../src/lib/runtime-core-shared.ts";

test("clones objects with callable prototypes while preserving their data", () => {
  const callablePrototype = Object.assign(() => "callable", {
    inheritedMarker: "callable-prototype",
  });
  const original: Record<string, unknown> = {};
  Object.setPrototypeOf(original, callablePrototype);
  original.nested = { status: "original" };

  const clone = cloneSnapshotPreservingFunctions(original);

  expect(Object.getPrototypeOf(clone)).toBe(callablePrototype);
  expect(clone.inheritedMarker).toBe("callable-prototype");
  expect(clone.nested).toEqual({ status: "original" });
  expect(clone.nested).not.toBe(original.nested);
});
