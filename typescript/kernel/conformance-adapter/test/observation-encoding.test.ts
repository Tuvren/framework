import { expect, test } from "bun:test";

import {
  encodeObservationBytes,
  encodeObservationInteger,
  encodeObservationRecord,
} from "../src/observation-encoding.ts";

test("bytes preserve view boundaries and remain distinct from integer arrays", () => {
  expect(
    encodeObservationBytes(Uint8Array.of(255, 0, 1, 254).subarray(1, 3))
  ).toEqual({ $bytes: "0001" });
  expect(encodeObservationRecord([0, 1])).toEqual([0, 1]);
  expect(
    encodeObservationRecord({
      $bytes: "user data",
      nested: Uint8Array.of(0, 255),
    })
  ).toEqual({
    $map: [
      ["$bytes", "user data"],
      ["nested", { $bytes: "00ff" }],
    ],
  });
});
test("integer helpers reject values JSON serialization would lose", () => {
  for (const value of [
    0.5,
    -0,
    Number.NaN,
    Infinity,
    -Infinity,
    9_007_199_254_740_992,
  ]) {
    expect(() => encodeObservationInteger(value)).toThrow();
  }
  for (const value of [-9_007_199_254_740_991, 0, 9_007_199_254_740_991]) {
    expect(encodeObservationInteger(value)).toBe(value);
  }
});
