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
import { TuvrenRuntimeError } from "@tuvren/runtime";
import type {
  PlaygroundBackendMode,
  PlaygroundConfig,
  PlaygroundKernelMode,
  PlaygroundProviderMode,
  PlaygroundScenarioName,
} from "./playground-types.js";

const AUTO_SQLITE_PATH_VALUE = "auto";
export const INVALID_REPL_CONFIG_CODE = "invalid_repl_config";
export const DEFAULT_GEMINI_PLAYGROUND_MODEL_ID = "gemini-2.5-flash";
export const AIMOCK_PLAYGROUND_PROVIDER_MODES = [
  "aimock-openai",
  "aimock-anthropic",
  "aimock-google",
] as const;
const OPTION_KEY_MAP = {
  "aimock-base-url": "aimockBaseUrl",
  backend: "backend",
  "kernel-grpc-base-url": "kernelGrpcBaseUrl",
  "kernel-mode": "kernelMode",
  "model-id": "modelId",
  provider: "provider",
  scenario: "scenario",
  "sqlite-path": "sqlitePath",
} as const;

export const DEFAULT_PLAYGROUND_SCENARIOS: readonly PlaygroundScenarioName[] = [
  "streaming",
  "structured",
  "tools",
  "approval",
  "cancel",
  "metadata",
  "branching",
  "steering",
  "extension",
  "orchestration",
];

export const DEFAULT_GEMINI_PLAYGROUND_SCENARIOS: readonly PlaygroundScenarioName[] =
  ["streaming", "metadata", "structured", "tools", "approval"];

export function loadPlaygroundConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[]
): PlaygroundConfig {
  const options = parseArgs(argv);
  const config = {
    aimockBaseUrl: normalizeAimockBaseUrl(
      options.aimockBaseUrl ?? readReplEnv(env, "AIMOCK_BASE_URL")
    ),
    backend: parseBackend(options.backend ?? readReplEnv(env, "BACKEND")),
    googleApiKey: resolveGoogleApiKey(env),
    kernelGrpcBaseUrl: normalizeKernelGrpcBaseUrl(
      options.kernelGrpcBaseUrl ?? readReplEnv(env, "KERNEL_GRPC_BASE_URL")
    ),
    kernelMode: parseKernelMode(
      options.kernelMode ?? readReplEnv(env, "KERNEL_MODE")
    ),
    modelId: normalizeModelId(options.modelId ?? readReplEnv(env, "MODEL_ID")),
    providerMode: parseProviderMode(
      options.provider ?? readReplEnv(env, "PROVIDER_MODE")
    ),
    scenario: parseScenario(
      normalizeScenarioValue(options.scenario ?? readReplEnv(env, "SCENARIO"))
    ),
    sqlitePath: normalizeSqlitePath(
      options.sqlitePath ?? readReplEnv(env, "SQLITE_PATH")
    ),
    systemPrompt: normalizeSystemPrompt(
      readReplEnv(env, "SYSTEM_PROMPT") ??
        readReplEnv(env, "SYSTEM_INSTRUCTIONS")
    ),
  } satisfies PlaygroundConfig;

  assertValidPlaygroundConfig(config);

  return {
    ...config,
    modelId:
      config.providerMode === "ai-sdk-google"
        ? (config.modelId ?? DEFAULT_GEMINI_PLAYGROUND_MODEL_ID)
        : config.modelId,
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

function normalizeScenarioValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  return normalized.length === 0 ? undefined : normalized;
}

function normalizeSystemPrompt(value: string | undefined): string | undefined {
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

export function readReplEnv(
  env: Record<string, string | undefined>,
  suffix:
    | "AIMOCK_BASE_URL"
    | "BACKEND"
    | "KERNEL_GRPC_BASE_URL"
    | "KERNEL_MODE"
    | "MODEL_ID"
    | "PROVIDER_MODE"
    | "SCENARIO"
    | "SQLITE_PATH"
    | "SYSTEM_INSTRUCTIONS"
    | "SYSTEM_PROMPT"
): string | undefined {
  return env[`TUVREN_REPL_${suffix}`] ?? env[`TUVREN_PLAYGROUND_${suffix}`];
}

export function assertValidPlaygroundConfig(config: PlaygroundConfig): void {
  if (config.backend === "sqlite" && config.sqlitePath === undefined) {
    throw new TuvrenRuntimeError(
      "sqlite repl scenarios require --sqlite-path, TUVREN_REPL_SQLITE_PATH, or TUVREN_PLAYGROUND_SQLITE_PATH",
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  if (
    isAimockProviderMode(config.providerMode) &&
    config.aimockBaseUrl === undefined
  ) {
    throw new TuvrenRuntimeError(
      `${config.providerMode} repl provider requires --aimock-base-url, TUVREN_REPL_AIMOCK_BASE_URL, or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`,
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  if (
    config.providerMode === "ai-sdk-google" &&
    config.googleApiKey === undefined
  ) {
    throw new TuvrenRuntimeError(
      "ai-sdk-google repl provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY",
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  if (
    config.kernelMode === "rust-grpc" &&
    config.kernelGrpcBaseUrl === undefined
  ) {
    throw new TuvrenRuntimeError(
      "rust-grpc repl kernel requires --kernel-grpc-base-url, TUVREN_REPL_KERNEL_GRPC_BASE_URL, or TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL",
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }

  if (config.kernelMode === "rust-grpc" && config.backend !== "memory") {
    throw new TuvrenRuntimeError(
      "rust-grpc repl kernel currently supports only the memory backend baseline",
      {
        code: INVALID_REPL_CONFIG_CODE,
      }
    );
  }
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const optionKey = OPTION_KEY_MAP[key as keyof typeof OPTION_KEY_MAP];

    if (optionKey === undefined) {
      throw new TuvrenRuntimeError(`unsupported repl option --${key}`, {
        code: INVALID_REPL_CONFIG_CODE,
      });
    }

    const next = argv[index + 1];

    if (next === undefined || next.startsWith("--")) {
      throw new TuvrenRuntimeError(`missing value for --${key}`, {
        code: INVALID_REPL_CONFIG_CODE,
      });
    }

    options[optionKey] = next;
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
      throw new TuvrenRuntimeError(`unsupported repl backend "${normalized}"`, {
        code: INVALID_REPL_CONFIG_CODE,
      });
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
        `unsupported repl kernel mode "${normalized}"`,
        {
          code: INVALID_REPL_CONFIG_CODE,
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
        `unsupported repl provider mode "${normalized}"`,
        {
          code: INVALID_REPL_CONFIG_CODE,
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
    case "extension":
    case "metadata":
    case "orchestration":
    case "reload":
    case "steering":
    case "streaming":
    case "structured":
    case "tools":
      return normalized;
    default:
      throw new TuvrenRuntimeError(
        `unsupported repl scenario "${normalized}"`,
        {
          code: INVALID_REPL_CONFIG_CODE,
        }
      );
  }
}
