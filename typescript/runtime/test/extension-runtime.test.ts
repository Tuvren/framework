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

import type { TuvrenExtension } from "@tuvren/core/extensions";

import {
  createContextManifest,
  runAfterIterationHooks,
  runBeforeTurnHooks,
} from "../src/index.ts";

const extensionCount = 20_000;

describe("extension hook traversal", () => {
  test("runs the last beforeTurn handler after skipping many absent handlers", async () => {
    const extensions: TuvrenExtension[] = Array.from(
      { length: extensionCount },
      (_, index) => ({ name: `extension-${index}` })
    );
    const emittedEvents: { data: unknown; name: string }[] = [];
    const lastExtension = extensions[extensionCount - 1];

    if (lastExtension === undefined) {
      throw new Error("expected a final extension");
    }

    lastExtension.beforeTurn = (context) => {
      context.emit({ data: { visited: true }, name: "before-turn" });
      return { state: { visited: true } };
    };

    const result = await runBeforeTurnHooks({
      emit: (event) => {
        emittedEvents.push(event);
      },
      extensions,
      iterationCount: 0,
      manifest: createContextManifest([]),
      messages: [],
      runId: "large-before-turn",
      turnId: "large-before-turn",
    });

    expect(result.updates).toEqual([
      { extensionName: lastExtension.name, state: { visited: true } },
    ]);
    expect(emittedEvents).toEqual([
      { data: { visited: true }, name: "before-turn" },
    ]);
    expect(result.resolution).toBeUndefined();
  });

  test("runs the last afterIteration handler after skipping many absent handlers", async () => {
    const extensions: TuvrenExtension[] = Array.from(
      { length: extensionCount },
      (_, index) => ({ name: `extension-${index}` })
    );
    const emittedEvents: { data: unknown; name: string }[] = [];
    const [lastVisitedExtension] = extensions;

    if (lastVisitedExtension === undefined) {
      throw new Error("expected a first extension");
    }

    lastVisitedExtension.afterIteration = (context) => {
      context.emit({ data: { visited: true }, name: "after-iteration" });
      return { state: { visited: true } };
    };

    const result = await runAfterIterationHooks({
      emit: (event) => {
        emittedEvents.push(event);
      },
      extensions,
      iterationCount: 1,
      manifest: createContextManifest([]),
      messages: [],
      resolution: { type: "continue_iteration" },
      response: { finishReason: "stop", parts: [] },
      runId: "large-after-iteration",
      turnId: "large-after-iteration",
    });

    expect(result.updates).toEqual([
      { extensionName: lastVisitedExtension.name, state: { visited: true } },
    ]);
    expect(emittedEvents).toEqual([
      { data: { visited: true }, name: "after-iteration" },
    ]);
    expect(result.resolution).toBeUndefined();
  });
});
