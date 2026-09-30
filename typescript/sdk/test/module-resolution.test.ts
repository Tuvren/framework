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

// SDK module identity: the SDK package composes the internal `@tuvren/runtime`
// engine and re-exports the `@tuvren/core` error family, so one host process
// must observe exactly one `@tuvren/core` module. These cases assert the
// behavioural consequence — a real public error thrown through the composed
// runtime is an instance of the very same `TuvrenRuntimeError` constructor the
// test imports — rather than mere specifier resolution.

import { describe, expect, test } from "bun:test";
import { createMemoryBackend } from "@tuvren/backend-memory";
import { TuvrenRuntimeError } from "@tuvren/core";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import { createRunnerRegistry, createTuvrenRuntime } from "@tuvren/runtime";
import { createStaticRunner } from "../../runtime/test/orchestration-runtime-runner-helpers.ts";
import { createTuvren } from "../src/lib/create-tuvren.js";

function moduleResolutionRunnerFactory() {
  return {
    create: () =>
      createStaticRunner(() => ({
        messages: [],
        resolution: { reason: "done", type: "end_turn" },
      })),
    id: "module-resolution-runner",
  };
}

async function capturePurgeScopeRejection(
  purgeScope: () => Promise<void>
): Promise<unknown> {
  try {
    await purgeScope();
  } catch (error: unknown) {
    return error;
  }

  return undefined;
}

describe("sdk module resolution", () => {
  test("the composed SDK runtime throws the TuvrenRuntimeError constructor @tuvren/core exports", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    await using instance = await createTuvren({
      backend: createMemoryBackend(),
      kernel,
      runner: moduleResolutionRunnerFactory(),
    });

    // An externally supplied kernel leaves the partition drop without an owned
    // substrate, so the public maintenance surface rejects.
    const thrown = await capturePurgeScopeRejection(() =>
      instance.runtime.maintenance.purgeScope()
    );

    expect(thrown).toBeInstanceOf(TuvrenRuntimeError);
    await expect(instance.runtime.maintenance.purgeScope()).rejects.toThrow(
      TuvrenRuntimeError
    );

    if (!(thrown instanceof TuvrenRuntimeError)) {
      throw new Error(
        "expected maintenance.purgeScope() to reject with TuvrenRuntimeError"
      );
    }

    expect(thrown.constructor).toBe(TuvrenRuntimeError);
    expect(thrown.code).toBe("scope_purge_unsupported");
  });

  test("the runtime package shares that same TuvrenRuntimeError constructor", async () => {
    const runtime = createTuvrenRuntime({
      defaultRunnerId: "module-resolution-runner",
      kernel: createRuntimeKernel({ backend: createMemoryBackend() }),
      runnerRegistry: createRunnerRegistry([]),
    });

    const thrown = await capturePurgeScopeRejection(() =>
      runtime.maintenance.purgeScope()
    );

    expect(thrown).toBeInstanceOf(TuvrenRuntimeError);
    await expect(runtime.maintenance.purgeScope()).rejects.toThrow(
      TuvrenRuntimeError
    );

    if (!(thrown instanceof TuvrenRuntimeError)) {
      throw new Error(
        "expected maintenance.purgeScope() to reject with TuvrenRuntimeError"
      );
    }

    expect(thrown.constructor).toBe(TuvrenRuntimeError);
  });
});
