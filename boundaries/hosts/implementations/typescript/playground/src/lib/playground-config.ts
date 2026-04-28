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

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuvrenRuntimeError } from "@tuvren/core-types";
import type {
  PlaygroundBackendMode,
  PlaygroundConfig,
  PlaygroundProviderMode,
  PlaygroundScenarioName,
} from "./playground-types.js";

const AUTO_SQLITE_PATH_VALUE = "auto";

export const DEFAULT_PLAYGROUND_SCENARIOS: readonly PlaygroundScenarioName[] = [
  "streaming",
  "structured",
  "tools",
  "approval",
  "cancel",
  "metadata",
  "branching",
  "steering",
  "reload",
];

export function loadPlaygroundConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[]
): PlaygroundConfig {
  const options = parseArgs(argv);
  const backend = parseBackend(
    options.backend ?? env.TUVREN_PLAYGROUND_BACKEND
  );
  const scenario = parseScenario(
    options.scenario ?? env.TUVREN_PLAYGROUND_SCENARIO
  );
  const providerMode = parseProviderMode(
    options.provider ?? env.TUVREN_PLAYGROUND_PROVIDER_MODE
  );
  const sqlitePath = normalizeSqlitePath(
    options.sqlitePath ?? env.TUVREN_PLAYGROUND_SQLITE_PATH
  );

  if (backend === "sqlite" && sqlitePath === undefined) {
    throw new TuvrenRuntimeError(
      "sqlite playground scenarios require --sqlite-path or TUVREN_PLAYGROUND_SQLITE_PATH",
      {
        code: "invalid_playground_config",
      }
    );
  }

  return {
    backend,
    providerMode,
    scenario,
    sqlitePath,
  };
}

function normalizeSqlitePath(value: string | undefined): string | undefined {
  if (value !== AUTO_SQLITE_PATH_VALUE) {
    return value;
  }

  // The Nx SQLite smoke target passes "auto" so repeated validation cannot
  // inherit stale durable state from a previous run.
  return join(tmpdir(), `tuvren-playground-${randomUUID()}.sqlite`);
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (next === undefined || next.startsWith("--")) {
      throw new TuvrenRuntimeError(`missing value for --${key}`, {
        code: "invalid_playground_config",
      });
    }

    options[toCamelKey(key)] = next;
    index += 1;
  }

  return options;
}

function parseBackend(value: string | undefined): PlaygroundBackendMode {
  const normalized = value ?? "memory";

  switch (normalized) {
    case "memory":
    case "sqlite":
      return normalized;
    default:
      throw new TuvrenRuntimeError(
        `unsupported playground backend "${normalized}"`,
        {
          code: "invalid_playground_config",
        }
      );
  }
}

function parseProviderMode(value: string | undefined): PlaygroundProviderMode {
  const normalized = value ?? "fixture";

  switch (normalized) {
    case "ai-sdk-mock":
    case "fixture":
      return normalized;
    default:
      throw new TuvrenRuntimeError(
        `unsupported playground provider mode "${normalized}"`,
        {
          code: "invalid_playground_config",
        }
      );
  }
}

function parseScenario(value: string | undefined): PlaygroundScenarioName {
  const normalized = value ?? "streaming";

  switch (normalized) {
    case "approval":
    case "branching":
    case "cancel":
    case "metadata":
    case "reload":
    case "steering":
    case "streaming":
    case "structured":
    case "tools":
      return normalized;
    default:
      throw new TuvrenRuntimeError(
        `unsupported playground scenario "${normalized}"`,
        {
          code: "invalid_playground_config",
        }
      );
  }
}

function toCamelKey(key: string): string {
  return key.replaceAll(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase()
  );
}
