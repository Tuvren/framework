/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_PATTERN =
  /-?(?<whole>0|[1-9]\d*)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?/uy;
const STRING_PATTERN = /"(?:[^"\\]|\\.)*"/uy;
const TRAILING_ZEROS = /0+$/u;
const ALL_ZEROS = /^0*$/u;

export class ObservationEncodingError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "ObservationEncodingError";
    this.offset = offset;
  }
}

/** Decides from the token's digits alone whether it denotes an integer. */
const isIntegerToken = (
  groups: Record<string, string | undefined>
): boolean => {
  const digits = `${groups.whole ?? ""}${groups.fraction ?? ""}`;
  const significant = digits.replace(TRAILING_ZEROS, "");

  if (ALL_ZEROS.test(significant)) {
    return true;
  }

  const trailingZeros = BigInt(digits.length - significant.length);
  const scale =
    BigInt(groups.exponent ?? "0") - BigInt(groups.fraction?.length ?? 0);

  return scale + trailingZeros >= 0n;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameRecordValue = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => sameRecordValue(entry, right[index]))
    );
  }

  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    return (
      leftKeys.length === Object.keys(right).length &&
      leftKeys.every(
        (key) =>
          Object.hasOwn(right, key) && sameRecordValue(left[key], right[key])
      )
    );
  }

  return left === right;
};

const assertDistinctMapKeys = (entries: unknown, offset: number): void => {
  if (!Array.isArray(entries)) {
    return;
  }

  const keys: unknown[] = [];

  for (const entry of entries) {
    if (!Array.isArray(entry)) {
      continue;
    }

    const [key] = entry;

    if (keys.some((seen) => sameRecordValue(seen, key))) {
      throw new ObservationEncodingError(
        `duplicate $map key ${JSON.stringify(key)}`,
        offset
      );
    }

    keys.push(key);
  }
};

class StrictJsonReader {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  read(): unknown {
    const value = this.readValue();
    this.skipWhitespace();

    if (this.index !== this.text.length) {
      throw new ObservationEncodingError(
        "unexpected trailing text",
        this.index
      );
    }

    return value;
  }

  private skipWhitespace(): void {
    while (WHITESPACE.has(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private readValue(): unknown {
    this.skipWhitespace();
    const char = this.text[this.index];

    switch (char) {
      case "{": {
        return this.readObject();
      }
      case "[": {
        return this.readArray();
      }
      case '"': {
        return this.readString();
      }
      default: {
        return this.readLiteralOrNumber();
      }
    }
  }

  private readObject(): Record<string, unknown> {
    const start = this.index;
    const value: Record<string, unknown> = {};
    this.index += 1;
    this.skipWhitespace();

    if (this.text[this.index] === "}") {
      this.index += 1;
      return value;
    }

    for (;;) {
      this.skipWhitespace();
      const keyOffset = this.index;

      if (this.text[this.index] !== '"') {
        throw new ObservationEncodingError("expected object key", this.index);
      }

      const key = this.readString();

      if (Object.hasOwn(value, key)) {
        throw new ObservationEncodingError(
          `duplicate object key ${JSON.stringify(key)}`,
          keyOffset
        );
      }

      this.skipWhitespace();
      this.expect(":");
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: this.readValue(),
        writable: true,
      });
      this.skipWhitespace();

      if (this.text[this.index] === ",") {
        this.index += 1;
        continue;
      }

      this.expect("}");
      break;
    }

    if (Object.hasOwn(value, "$map")) {
      assertDistinctMapKeys(value.$map, start);
    }

    return value;
  }

  private readArray(): unknown[] {
    const value: unknown[] = [];
    this.index += 1;
    this.skipWhitespace();

    if (this.text[this.index] === "]") {
      this.index += 1;
      return value;
    }

    for (;;) {
      value.push(this.readValue());
      this.skipWhitespace();

      if (this.text[this.index] === ",") {
        this.index += 1;
        continue;
      }

      this.expect("]");
      return value;
    }
  }

  private readString(): string {
    STRING_PATTERN.lastIndex = this.index;
    const match = STRING_PATTERN.exec(this.text);

    if (match === null) {
      throw new ObservationEncodingError("invalid string", this.index);
    }

    const offset = this.index;
    this.index += match[0].length;

    try {
      return JSON.parse(match[0]) as string;
    } catch {
      throw new ObservationEncodingError("invalid string", offset);
    }
  }

  private readLiteralOrNumber(): unknown {
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }

    const offset = this.index;
    NUMBER_PATTERN.lastIndex = offset;
    const match = NUMBER_PATTERN.exec(this.text);

    if (match === null) {
      throw new ObservationEncodingError("unexpected token", offset);
    }

    this.index += match[0].length;
    const value = Number(match[0]);

    if (!Number.isFinite(value)) {
      throw new ObservationEncodingError("non-finite number", offset);
    }

    if (Object.is(value, -0)) {
      throw new ObservationEncodingError("negative zero", offset);
    }

    // A non-integer token whose float64 value is integral would pass integer
    // checks after rounding; it has no lossless number representation.
    if (Number.isInteger(value) && !isIntegerToken(match.groups ?? {})) {
      throw new ObservationEncodingError(
        "non-integer number rounds to an integer",
        offset
      );
    }

    return value;
  }

  private expect(char: string): void {
    if (this.text[this.index] !== char) {
      throw new ObservationEncodingError(`expected ${char}`, this.index);
    }

    this.index += 1;
  }
}

/**
 * Decodes one observation document under the ADR-0078 encoding profile:
 * duplicate object keys, duplicate `$map` keys, non-finite numbers, negative
 * zero, and non-integer tokens that would round to an integer are rejected
 * before any schema validation.
 */
export const parseObservationJson = (text: string): unknown =>
  new StrictJsonReader(text).read();
