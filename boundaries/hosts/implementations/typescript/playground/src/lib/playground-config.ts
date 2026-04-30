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
  PlaygroundKernelMode,
  PlaygroundProviderMode,
  PlaygroundScenarioName,
} from "./playground-types.js";

const AUTO_SQLITE_PATH_VALUE = "auto";
export const DEFAULT_GEMINI_PLAYGROUND_MODEL_ID = "gemini-2.5-flash";
export const AIMOCK_PLAYGROUND_PROVIDER_MODES = [
  "aimock-openai",
  "aimock-anthropic",
  "aimock-google",
] as const;

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

export const DEFAULT_GEMINI_PLAYGROUND_SCENARIOS: readonly PlaygroundScenarioName[] =
  ["streaming", "metadata", "structured", "tools", "approval"];

export function loadPlaygroundConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[]
): PlaygroundConfig {
  const options = parseArgs(argv);
  const backend = parseBackend(
    options.backend ?? env.TUVREN_PLAYGROUND_BACKEND
  );
  const kernelMode = parseKernelMode(
    options.kernelMode ?? env.TUVREN_PLAYGROUND_KERNEL_MODE
  );
  const scenario = parseScenario(
    options.scenario ?? env.TUVREN_PLAYGROUND_SCENARIO
  );
  const providerMode = parseProviderMode(
    options.provider ?? env.TUVREN_PLAYGROUND_PROVIDER_MODE
  );
  const modelId = normalizeModelId(
    options.modelId ?? env.TUVREN_PLAYGROUND_MODEL_ID
  );
  const googleApiKey = resolveGoogleApiKey(env);
  const aimockBaseUrl = normalizeAimockBaseUrl(
    options.aimockBaseUrl ?? env.TUVREN_PLAYGROUND_AIMOCK_BASE_URL
  );
  const kernelGrpcBaseUrl = normalizeKernelGrpcBaseUrl(
    options.kernelGrpcBaseUrl ?? env.TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL
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

  if (isAimockProviderMode(providerMode) && aimockBaseUrl === undefined) {
    throw new TuvrenRuntimeError(
      `${providerMode} playground provider requires --aimock-base-url or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`,
      {
        code: "invalid_playground_config",
      }
    );
  }

  if (providerMode === "ai-sdk-google" && googleApiKey === undefined) {
    throw new TuvrenRuntimeError(
      "ai-sdk-google playground provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY",
      {
        code: "invalid_playground_config",
      }
    );
  }

  if (kernelMode === "rust-grpc" && kernelGrpcBaseUrl === undefined) {
    throw new TuvrenRuntimeError(
      "rust-grpc playground kernel requires --kernel-grpc-base-url or TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL",
      {
        code: "invalid_playground_config",
      }
    );
  }

  if (kernelMode === "rust-grpc" && backend !== "memory") {
    throw new TuvrenRuntimeError(
      "rust-grpc playground kernel currently supports only the memory backend baseline",
      {
        code: "invalid_playground_config",
      }
    );
  }

  return {
    aimockBaseUrl,
    backend,
    googleApiKey,
    kernelGrpcBaseUrl,
    kernelMode,
    modelId:
      providerMode === "ai-sdk-google"
        ? (modelId ?? DEFAULT_GEMINI_PLAYGROUND_MODEL_ID)
        : modelId,
    providerMode,
    scenario,
    sqlitePath,
  };
}

function normalizeAimockBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  return normalized.length === 0 ? undefined : normalized;
}

function normalizeKernelGrpcBaseUrl(
  value: string | undefined
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  return normalized.length === 0 ? undefined : normalized;
}

function normalizeSqlitePath(value: string | undefined): string | undefined {
  if (value !== AUTO_SQLITE_PATH_VALUE) {
    return value;
  }

  // The Nx SQLite smoke target passes "auto" so repeated validation cannot
  // inherit stale durable state from a previous run.
  return join(tmpdir(), `tuvren-playground-${randomUUID()}.sqlite`);
}

function normalizeModelId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  return normalized.length === 0 ? undefined : normalized;
}

export function resolveGoogleApiKey(
  env: Record<string, string | undefined>
): string | undefined {
  const googleGenerativeAiApiKey = normalizeModelId(
    env.GOOGLE_GENERATIVE_AI_API_KEY
  );

  if (googleGenerativeAiApiKey !== undefined) {
    return googleGenerativeAiApiKey;
  }

  return normalizeModelId(env.GEMINI_API_KEY);
}

export function isAimockProviderMode(
  value: PlaygroundProviderMode
): value is (typeof AIMOCK_PLAYGROUND_PROVIDER_MODES)[number] {
  return (AIMOCK_PLAYGROUND_PROVIDER_MODES as readonly string[]).includes(
    value
  );
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

function parseKernelMode(value: string | undefined): PlaygroundKernelMode {
  const normalized = value ?? "typescript-local";

  switch (normalized) {
    case "rust-grpc":
    case "typescript-local":
      return normalized;
    default:
      throw new TuvrenRuntimeError(
        `unsupported playground kernel mode "${normalized}"`,
        {
          code: "invalid_playground_config",
        }
      );
  }
}

function parseProviderMode(value: string | undefined): PlaygroundProviderMode {
  const normalized = value ?? "fixture";

  switch (normalized) {
    case "aimock-anthropic":
    case "aimock-google":
    case "aimock-openai":
    case "ai-sdk-google":
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
