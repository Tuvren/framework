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

import type { ConformancePlanCapture } from "../plan-compiler/index.js";

export class ArgumentResolutionError extends Error {}

export interface ArgumentRoots {
  capture: Readonly<Record<string, unknown>>;
  fixture: unknown;
  input: unknown;
}

export interface StepObservation {
  events?: readonly unknown[];
  result?: unknown;
  state?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOwnSegments = (
  source: unknown,
  segments: readonly string[]
): unknown => {
  let current = source;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!(Number.isInteger(index) && index >= 0 && index < current.length)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!(isRecord(current) && Object.hasOwn(current, segment))) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
};

const REFERENCE_ROOTS: readonly (readonly [
  string,
  (roots: ArgumentRoots) => unknown,
])[] = [
  ["fixture.input.", (roots) => readOwnSegments(roots.fixture, ["input"])],
  ["input.", (roots) => roots.input],
  ["capture.", (roots) => roots.capture],
];

const resolveReference = (reference: string, roots: ArgumentRoots): unknown => {
  const root = REFERENCE_ROOTS.find(([prefix]) => reference.startsWith(prefix));

  if (root === undefined) {
    throw new ArgumentResolutionError(
      `$ref ${reference} does not use an allowed root (input, fixture.input, capture)`
    );
  }

  const [prefix, readRoot] = root;
  const value = readOwnSegments(
    readRoot(roots),
    reference.slice(prefix.length).split(".")
  );

  if (value === undefined) {
    throw new ArgumentResolutionError(`$ref ${reference} did not resolve`);
  }

  return value;
};

export const resolveStepArguments = (
  value: unknown,
  roots: ArgumentRoots
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveStepArguments(entry, roots));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (Object.hasOwn(value, "$ref")) {
    const reference = value.$ref;

    if (typeof reference !== "string") {
      throw new ArgumentResolutionError("$ref must be a string");
    }

    return resolveReference(reference, roots);
  }

  if (Object.hasOwn(value, "$literal")) {
    return value.$literal;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveStepArguments(entry, roots),
    ])
  );
};

export interface CaptureStore {
  readonly declared: Set<string>;
  readonly values: Record<string, unknown>;
}

export const createCaptureStore = (): CaptureStore => ({
  declared: new Set(),
  values: Object.create(null) as Record<string, unknown>,
});

/**
 * A capture whose path is absent from the observation is not recorded, so any
 * later `$ref` or assertion operand that reads it fails as unresolved. Its name
 * still counts as declared.
 */
export const recordStepCaptures = (
  captures: readonly ConformancePlanCapture[] | undefined,
  observation: StepObservation,
  store: CaptureStore
): void => {
  for (const { name, path } of captures ?? []) {
    if (store.declared.has(name)) {
      throw new ArgumentResolutionError(`capture ${name} is already defined`);
    }

    store.declared.add(name);
    const value = readOwnSegments(
      {
        events: observation.events,
        result: observation.result,
        state: observation.state,
      },
      path.split(".")
    );

    if (value !== undefined) {
      store.values[name] = value;
    }
  }
};
