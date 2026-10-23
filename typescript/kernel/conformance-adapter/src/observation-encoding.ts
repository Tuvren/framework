import type { KernelRecord } from "@tuvren/core";
import type { TuvrenJsonValue } from "@tuvren/core/messages";

export interface EncodedBytes {
  $bytes: string;
}

export const encodeObservationBytes = (bytes: Uint8Array): EncodedBytes => ({
  $bytes: Buffer.from(bytes).toString("hex"),
});

export const encodeObservationInteger = (value: number): number => {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new TypeError(
      "observation integers must be safe integers without negative zero"
    );
  }
  return value;
};

export const encodeObservationRecord = (
  value: KernelRecord
): TuvrenJsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return encodeObservationInteger(value);
  }
  if (value instanceof Uint8Array) {
    return { $bytes: encodeObservationBytes(value).$bytes };
  }
  if (Array.isArray(value)) {
    return value.map(encodeObservationRecord);
  }
  return {
    $map: Object.entries(value).map(([key, entry]) => [
      key,
      encodeObservationRecord(entry),
    ]),
  };
};
