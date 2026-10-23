import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error("expected identity recipe object");
  }
  return value;
};
const strings = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((entry: unknown) => typeof entry === "string")
  ) {
    throw new Error("expected identity projection fields");
  }
  return value;
};
const authority = object(
  JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../spec/conformance/kernel/identity-recipes.json"
      ),
      "utf-8"
    )
  )
);
if (!Array.isArray(authority.recipes)) {
  throw new TypeError("missing identity recipes");
}
const recipes = authority.recipes.map(object);
const CBOR_PROFILE = {
  argumentEncoding:
    "0..23-inline; 24..255-uint8; 256..65535-uint16; 65536..4294967295-uint32; larger-uint64; big-endian",
  arrayOrder: "preserve",
  bytesEncoding: "untagged-major-type-2",
  encoding: "deterministic-cbor",
  integerDomain: [-9_007_199_254_740_991, 9_007_199_254_740_991],
  integerEncoding:
    "major-type-0-for-n>=0; major-type-1-with-argument=-1-n-for-n<0; shortest-argument-width; no-floats",
  lengthEncoding:
    "shortest-definite-length; text-length-is-utf8-byte-count; map-length-is-entry-count",
  mapKeyOrder:
    "unsigned-bytewise-lexicographic-deterministic-cbor-encoded-text-keys",
  negativeZero: false,
  tags: false,
  textEncoding: "utf-8-without-normalization",
};

const recipeFor = (recordType: string): Record<string, unknown> => {
  const recipe = recipes.find((entry) => entry.recordType === recordType);
  if (recipe === undefined || recipe.hash !== "sha256") {
    throw new Error(`unsupported identity recipe ${recordType}`);
  }
  const profile = object(recipe.cborProfile);
  const expected =
    recordType === "opaque-object" ? { encoding: "raw-bytes" } : CBOR_PROFILE;
  if (
    Object.keys(profile).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([key, value]) => JSON.stringify(profile[key]) !== JSON.stringify(value)
    )
  ) {
    throw new Error(`unsupported CBOR profile for ${recordType}`);
  }
  return recipe;
};
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/u;
export const observationBytes = (value: unknown): Uint8Array => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.$bytes !== "string" ||
    !HEX_BYTES.test(value.$bytes)
  ) {
    throw new Error("expected lossless $bytes");
  }
  return Uint8Array.from(Buffer.from(value.$bytes, "hex"));
};
export const digestBytes = (value: unknown): string =>
  createHash("sha256").update(observationBytes(value)).digest("hex");

const concat = (parts: readonly Uint8Array[]): Uint8Array =>
  Uint8Array.from(Buffer.concat(parts));
const head = (major: number, value: number): Uint8Array => {
  const n = BigInt(value);
  if (n < 24n) {
    return Uint8Array.of(major * 32 + value);
  }
  const widths = [1, 2, 4, 8];
  const width = widths.find((size) => n < 256n ** BigInt(size)) ?? 8;
  const bytes = new Uint8Array(width + 1);
  bytes[0] = major * 32 + 24 + widths.indexOf(width);
  let rest = n;
  for (let index = width; index > 0; index -= 1) {
    bytes[index] = Number(rest % 256n);
    rest /= 256n;
  }
  return bytes;
};
const encodeMap = (
  entries: readonly (readonly [string, unknown])[],
  encode: (value: unknown) => Uint8Array
): Uint8Array => {
  const keys = new Set<string>();
  const encoded = entries
    .map(([key, value]) => {
      if (keys.has(key)) {
        throw new Error(`duplicate kernel map key ${key}`);
      }
      keys.add(key);
      return { key: encode(key), value: encode(value) };
    })
    .toSorted((left, right) => Buffer.compare(left.key, right.key));
  return concat([
    head(5, encoded.length),
    ...encoded.flatMap((entry) => [entry.key, entry.value]),
  ]);
};
const encodeKernelValue = (value: unknown): Uint8Array => {
  if (value === null) {
    return Uint8Array.of(246);
  }
  if (typeof value === "boolean") {
    return Uint8Array.of(value ? 245 : 244);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(
        "kernel identity requires safe integers without negative zero"
      );
    }
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf-8");
    return concat([head(3, text.length), text]);
  }
  if (Array.isArray(value)) {
    return concat([head(4, value.length), ...value.map(encodeKernelValue)]);
  }
  if (!isRecord(value)) {
    throw new Error("unsupported kernel identity value");
  }
  if (Object.hasOwn(value, "$bytes")) {
    const bytes = observationBytes(value);
    return concat([head(2, bytes.length), bytes]);
  }
  if (Object.hasOwn(value, "$map")) {
    if (Object.keys(value).length !== 1 || !Array.isArray(value.$map)) {
      throw new Error("invalid $map");
    }
    const entries: [string, unknown][] = value.$map.map((entry: unknown) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string"
      ) {
        throw new Error("kernel maps require text keys");
      }
      return [entry[0], entry[1]];
    });
    return encodeMap(entries, encodeKernelValue);
  }
  return encodeMap(Object.entries(value), encodeKernelValue);
};
const project = (
  value: unknown,
  projection: Record<string, unknown>
): Record<string, unknown> => {
  const source = object(value);
  const optional = strings(projection.optionalFields ?? []);
  return Object.fromEntries(
    strings(projection.fields).flatMap((field) => {
      if (!Object.hasOwn(source, field)) {
        if (!optional.includes(field)) {
          throw new Error(`missing identity field ${field}`);
        }
        return [];
      }
      let entry = source[field];
      if (
        field === "consumedStagedResults" &&
        projection.stagedResultProjection !== undefined
      ) {
        if (!Array.isArray(entry)) {
          throw new TypeError("expected consumed staged results");
        }
        entry = entry.map((item: unknown) =>
          project(item, object(projection.stagedResultProjection))
        );
      }
      return [[field, entry]];
    })
  );
};

export const encodeIdentity = (
  recordType: string,
  value: unknown
): Uint8Array => {
  const recipe = recipeFor(recordType);
  const projection = object(recipe.projection);
  if (recordType === "opaque-object") {
    if (projection.source !== "bytes") {
      throw new Error("unsupported opaque projection");
    }
    return observationBytes(value);
  }
  return encodeKernelValue(project(value, projection));
};
export const computeIdentity = (recordType: string, value: unknown): string =>
  createHash("sha256").update(encodeIdentity(recordType, value)).digest("hex");
