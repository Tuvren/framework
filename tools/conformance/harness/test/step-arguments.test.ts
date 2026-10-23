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

import { describe, expect, test } from "bun:test";

import {
  ArgumentResolutionError,
  createCaptureStore,
  recordStepCaptures,
  resolveStepArguments,
} from "../step-arguments.ts";

describe("step argument captures", () => {
  test("stores a capture named __proto__ as an own data property", () => {
    const store = createCaptureStore();
    recordStepCaptures(
      [{ name: "__proto__", path: "result.value" }],
      { result: { value: { polluted: true } } },
      store
    );

    expect(Object.getPrototypeOf(store.values)).toBeNull();
    expect(Object.hasOwn(store.values, "__proto__")).toBe(true);
    expect(
      resolveStepArguments(
        { value: { $ref: "capture.__proto__" } },
        { capture: store.values, fixture: undefined, input: undefined }
      )
    ).toEqual({ value: { polluted: true } });
  });

  test("does not resolve inherited properties of the capture root", () => {
    const store = createCaptureStore();

    expect(() =>
      resolveStepArguments(
        { $ref: "capture.toString" },
        { capture: store.values, fixture: undefined, input: undefined }
      )
    ).toThrow(ArgumentResolutionError);
  });

  test("rejects a reused capture name even when the first capture was absent", () => {
    const store = createCaptureStore();
    recordStepCaptures(
      [{ name: "token", path: "result.absent" }],
      { result: { token: "first" } },
      store
    );

    expect(Object.hasOwn(store.values, "token")).toBe(false);
    expect(() => {
      recordStepCaptures(
        [{ name: "token", path: "result.token" }],
        { result: { token: "second" } },
        store
      );
    }).toThrow("capture token is already defined");
  });

  test("rejects a reused capture name within a single step", () => {
    const store = createCaptureStore();

    expect(() => {
      recordStepCaptures(
        [
          { name: "token", path: "result.absent" },
          { name: "token", path: "result.token" },
        ],
        { result: { token: "value" } },
        store
      );
    }).toThrow("capture token is already defined");
  });

  test("records an empty events array", () => {
    const store = createCaptureStore();
    recordStepCaptures(
      [{ name: "events", path: "events" }],
      { events: [] },
      store
    );

    expect(store.values.events).toEqual([]);
  });
});
