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

import {
  assertKrakenDriver,
  type DriverRegistry,
  type KrakenDriver,
  type KrakenDriverFactory,
} from "@kraken/framework-driver-api";
import { KrakenRuntimeError } from "@kraken/shared-core-types";

type DriverEntry = KrakenDriver | KrakenDriverFactory;

class BasicDriverRegistry implements DriverRegistry {
  private readonly drivers = new Map<string, DriverEntry>();

  list(): DriverEntry[] {
    return [...this.drivers.values()];
  }

  register(driver: DriverEntry): void {
    const driverId = getDriverId(driver);

    if (this.drivers.has(driverId)) {
      throw new KrakenRuntimeError(
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

  resolve(driverId: string): DriverEntry | undefined {
    return this.drivers.get(driverId);
  }
}

export function createDriverRegistry(
  drivers: DriverEntry[] = []
): DriverRegistry {
  const registry = new BasicDriverRegistry();

  for (const driver of drivers) {
    registry.register(driver);
  }

  return registry;
}

export function materializeDriver(entry: DriverEntry): KrakenDriver {
  const candidate =
    "create" in entry && typeof entry.create === "function"
      ? entry.create()
      : entry;

  assertKrakenDriver(candidate, "driver");
  return candidate;
}

function getDriverId(driver: DriverEntry): string {
  if (typeof driver.id === "string" && driver.id.trim().length > 0) {
    return driver.id;
  }

  throw new KrakenRuntimeError("drivers must expose a non-empty id", {
    code: "invalid_driver_registration",
    details: {
      driver,
    },
  });
}
