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
  assertKrakenDriver,
  type DriverExecutionContext,
  isKrakenDriver,
  type KrakenDriver,
} from "../src/index.ts";

describe("driver-api", () => {
  test("accepts explicit driver contracts", async () => {
    const continueIteration = {
      type: "continue_iteration",
    } satisfies { type: "continue_iteration" };
    const driver = {
      execute(_context) {
        return Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        });
      },
      id: "react",
      resume(_context) {
        return Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        });
      },
    } satisfies KrakenDriver;

    expect(isKrakenDriver(driver)).toBe(true);
    expect(() => assertKrakenDriver(driver)).not.toThrow();
    const context: DriverExecutionContext = {
      branchId: "branch-1",
      config: { name: "primary" },
      runtime: {
        emit: () => undefined,
        now: () => 0,
      },
      schemaId: "schema-1",
      toolRegistry: {
        get: () => undefined,
        has: () => false,
        list: () => [],
        register: () => undefined,
        toDefinitions: () => [],
      },
      turnId: "turn-1",
    };

    await expect(driver.execute(context)).resolves.toEqual({
      activeAgent: "primary",
      resolution: { type: "continue_iteration" },
    });
  });

  test("rejects malformed driver contracts", () => {
    const continueIteration = {
      type: "continue_iteration",
    } satisfies { type: "continue_iteration" };
    expect(isKrakenDriver({ id: "react" })).toBe(false);
    expect(() => assertKrakenDriver({ id: "react" })).toThrow(
      "must be a valid KrakenDriver"
    );
    expect(
      isKrakenDriver({
        execute: () => undefined,
        id: "",
        resume: () => undefined,
      })
    ).toBe(false);
    expect(
      isKrakenDriver({
        execute: () => undefined,
        id: "   ",
        resume: () => undefined,
      })
    ).toBe(false);

    const hostileDriver = {
      execute: () =>
        Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        }),
      get id() {
        throw new Error("boom");
      },
      resume: () =>
        Promise.resolve({
          activeAgent: "primary",
          resolution: continueIteration,
        }),
    };

    expect(() => isKrakenDriver(hostileDriver)).not.toThrow();
    expect(isKrakenDriver(hostileDriver)).toBe(false);
  });
});
