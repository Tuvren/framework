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
  assertRuntimeRunner,
  type RunnerRegistry,
  type RuntimeRunner,
  type RuntimeRunnerFactory,
} from "@tuvren/core/runner";

type RunnerEntry = RuntimeRunner | RuntimeRunnerFactory;

class BasicRunnerRegistry implements RunnerRegistry {
  private readonly runners = new Map<string, RunnerEntry>();

  list(): RunnerEntry[] {
    return [...this.runners.values()];
  }

  register(runner: RunnerEntry): void {
    const runnerId = getRunnerId(runner);

    if (this.runners.has(runnerId)) {
      throw new TuvrenRuntimeError(
        `runner "${runnerId}" is already registered`,
        {
          code: "duplicate_runner_registration",
          details: {
            runnerId,
          },
        }
      );
    }

    this.runners.set(runnerId, runner);
  }

  resolve(runnerId: string): RunnerEntry | undefined {
    return this.runners.get(runnerId);
  }
}

export function createRunnerRegistry(
  runners: RunnerEntry[] = []
): RunnerRegistry {
  const registry = new BasicRunnerRegistry();

  for (const runner of runners) {
    registry.register(runner);
  }

  return registry;
}

export function materializeRunner(entry: RunnerEntry): RuntimeRunner {
  const candidate =
    "create" in entry && typeof entry.create === "function"
      ? entry.create()
      : entry;

  assertRuntimeRunner(candidate, "runner");
  return candidate;
}

function getRunnerId(runner: RunnerEntry): string {
  if (typeof runner.id === "string" && runner.id.trim().length > 0) {
    return runner.id;
  }

  throw new TuvrenRuntimeError("runners must expose a non-empty id", {
    code: "invalid_runner_registration",
    details: {
      runner,
    },
  });
}
