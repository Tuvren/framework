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

import { TuvrenRuntimeError } from "@tuvren/core";
import {
  assertRuntimeRunner as assertKrakenRunner,
  type RuntimeRunner as KrakenRunner,
  type RuntimeRunnerFactory as KrakenRunnerFactory,
  type RunnerRegistry,
} from "@tuvren/core/runner";

type RunnerEntry = KrakenRunner | KrakenRunnerFactory;

class BasicRunnerRegistry implements RunnerRegistry {
  private readonly drivers = new Map<string, RunnerEntry>();

  list(): RunnerEntry[] {
    return [...this.drivers.values()];
  }

  register(driver: RunnerEntry): void {
    const driverId = getRunnerId(driver);

    if (this.drivers.has(driverId)) {
      throw new TuvrenRuntimeError(
        `driver "${driverId}" is already registered`,
        {
          code: "duplicate_driver_registration",
          details: {
            driverId,
          },
        }
      );
    }

    this.drivers.set(driverId, driver);
  }

  resolve(driverId: string): RunnerEntry | undefined {
    return this.drivers.get(driverId);
  }
}

export function createRunnerRegistry(
  drivers: RunnerEntry[] = []
): RunnerRegistry {
  const registry = new BasicRunnerRegistry();

  for (const driver of drivers) {
    registry.register(driver);
  }

  return registry;
}

export function materializeRunner(entry: RunnerEntry): KrakenRunner {
  const candidate =
    "create" in entry && typeof entry.create === "function"
      ? entry.create()
      : entry;

  assertKrakenRunner(candidate, "driver");
  return candidate;
}

function getRunnerId(driver: RunnerEntry): string {
  if (typeof driver.id === "string" && driver.id.trim().length > 0) {
    return driver.id;
  }

  throw new TuvrenRuntimeError("drivers must expose a non-empty id", {
    code: "invalid_driver_registration",
    details: {
      driver,
    },
  });
}
