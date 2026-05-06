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
import { tmpdir } from "node:os";
import { createMemoryBackend } from "@tuvren/backend-memory";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import {
  AIMOCK_PLAYGROUND_PROVIDER_MODES,
  createPlaygroundHost,
  DEFAULT_GEMINI_PLAYGROUND_SCENARIOS,
  DEFAULT_PLAYGROUND_SCENARIOS,
  haveAllChecksPassed,
  loadPlaygroundConfig,
  runPlaygroundScenario,
  runPlaygroundScenarioMatrix,
} from "@tuvren/playground-host";
import {
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
} from "@tuvren/runtime-core";
import { createPlaygroundKernelInspector } from "../src/lib/playground-kernel.js";
import {
  expectPlaygroundConfigError,
  expectScenarioChecksPassed,
  withTemporaryEnv,
  withTemporaryEnvAsync,
} from "./playground-test-helpers.ts";

describe("playground host scenarios", () => {
  test("loads deterministic default configuration", () => {
    const config = loadPlaygroundConfig({}, []);

    expect(config).toEqual({
      aimockBaseUrl: undefined,
      backend: "memory",
      googleApiKey: undefined,
      kernelGrpcBaseUrl: undefined,
      kernelMode: "typescript-local",
      modelId: undefined,
      providerMode: "fixture",
      scenario: "streaming",
      sqlitePath: undefined,
    });
  });

  test("loads aimock provider configuration from argv and env", () => {
    expect(AIMOCK_PLAYGROUND_PROVIDER_MODES).toEqual([
      "aimock-openai",
      "aimock-anthropic",
      "aimock-google",
    ]);

    for (const providerMode of AIMOCK_PLAYGROUND_PROVIDER_MODES) {
      const argvConfig = loadPlaygroundConfig({}, [
        "--provider",
        providerMode,
        "--aimock-base-url",
        " http://127.0.0.1:4010/v1 ",
      ]);

      expect(argvConfig.providerMode).toBe(providerMode);
      expect(argvConfig.aimockBaseUrl).toBe("http://127.0.0.1:4010/v1");

      const envConfig = loadPlaygroundConfig(
        {
          TUVREN_PLAYGROUND_AIMOCK_BASE_URL: "http://127.0.0.1:4011/v1",
          TUVREN_PLAYGROUND_PROVIDER_MODE: providerMode,
        },
        []
      );

      expect(envConfig.providerMode).toBe(providerMode);
      expect(envConfig.aimockBaseUrl).toBe("http://127.0.0.1:4011/v1");
    }
  });

  test("loads ai-sdk-google configuration from argv and env", () => {
    const argvConfig = loadPlaygroundConfig(
      {
        GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
      },
      ["--provider", "ai-sdk-google", "--model-id", " gemini-2.5-pro "]
    );

    expect(argvConfig.providerMode).toBe("ai-sdk-google");
    expect(argvConfig.googleApiKey).toBe("google-key");
    expect(argvConfig.modelId).toBe("gemini-2.5-pro");

    const envConfig = loadPlaygroundConfig(
      {
        GEMINI_API_KEY: "gemini-key",
        TUVREN_PLAYGROUND_MODEL_ID: "gemini-2.5-flash-lite",
        TUVREN_PLAYGROUND_PROVIDER_MODE: "ai-sdk-google",
      },
      []
    );

    expect(envConfig.providerMode).toBe("ai-sdk-google");
    expect(envConfig.googleApiKey).toBe("gemini-key");
    expect(envConfig.modelId).toBe("gemini-2.5-flash-lite");
  });

  test("loads rust-grpc kernel configuration from argv and env", () => {
    const argvConfig = loadPlaygroundConfig({}, [
      "--kernel-mode",
      "rust-grpc",
      "--kernel-grpc-base-url",
      " http://127.0.0.1:50051 ",
    ]);

    expect(argvConfig.kernelMode).toBe("rust-grpc");
    expect(argvConfig.kernelGrpcBaseUrl).toBe("http://127.0.0.1:50051");

    const envConfig = loadPlaygroundConfig(
      {
        TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL: "http://127.0.0.1:50052",
        TUVREN_PLAYGROUND_KERNEL_MODE: "rust-grpc",
      },
      []
    );

    expect(envConfig.kernelMode).toBe("rust-grpc");
    expect(envConfig.kernelGrpcBaseUrl).toBe("http://127.0.0.1:50052");
  });

  test("uses parsed Gemini credentials for programmatic callers without mutating process.env", () => {
    const config = loadPlaygroundConfig(
      {
        GEMINI_API_KEY: "gemini-key",
        TUVREN_PLAYGROUND_PROVIDER_MODE: "ai-sdk-google",
      },
      []
    );

    withTemporaryEnv(
      {
        GEMINI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      () => {
        let thrownError: unknown;

        try {
          createPlaygroundHost(config);
        } catch (error: unknown) {
          thrownError = error;
        }

        expect(thrownError === undefined).toBe(true);
      }
    );
  });

  test("rejects aimock provider configuration without a usable base URL", () => {
    for (const providerMode of AIMOCK_PLAYGROUND_PROVIDER_MODES) {
      expectPlaygroundConfigError(
        () => loadPlaygroundConfig({}, ["--provider", providerMode]),
        `${providerMode} playground provider requires --aimock-base-url or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`
      );

      expectPlaygroundConfigError(
        () =>
          loadPlaygroundConfig(
            {
              TUVREN_PLAYGROUND_AIMOCK_BASE_URL: "   ",
              TUVREN_PLAYGROUND_PROVIDER_MODE: providerMode,
            },
            []
          ),
        `${providerMode} playground provider requires --aimock-base-url or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`
      );
    }
  });

  test("rejects ai-sdk-google configuration without a usable API key", () => {
    expectPlaygroundConfigError(
      () => loadPlaygroundConfig({}, ["--provider", "ai-sdk-google"]),
      "ai-sdk-google playground provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
    );

    expectPlaygroundConfigError(
      () =>
        loadPlaygroundConfig(
          {
            GEMINI_API_KEY: "   ",
            GOOGLE_GENERATIVE_AI_API_KEY: "",
            TUVREN_PLAYGROUND_PROVIDER_MODE: "ai-sdk-google",
          },
          []
        ),
      "ai-sdk-google playground provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
    );
  });

  test("rejects rust-grpc kernel configuration without a usable base URL", () => {
    expectPlaygroundConfigError(
      () => loadPlaygroundConfig({}, ["--kernel-mode", "rust-grpc"]),
      "rust-grpc playground kernel requires --kernel-grpc-base-url or TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL"
    );

    expectPlaygroundConfigError(
      () =>
        loadPlaygroundConfig(
          {
            TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL: " ",
            TUVREN_PLAYGROUND_KERNEL_MODE: "rust-grpc",
          },
          []
        ),
      "rust-grpc playground kernel requires --kernel-grpc-base-url or TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL"
    );
  });

  test("rejects rust-grpc kernel configuration for sqlite backend", () => {
    expectPlaygroundConfigError(
      () =>
        loadPlaygroundConfig(
          {
            TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL: "http://127.0.0.1:50051",
            TUVREN_PLAYGROUND_KERNEL_MODE: "rust-grpc",
          },
          ["--backend", "sqlite", "--sqlite-path", "auto"]
        ),
      "rust-grpc playground kernel currently supports only the memory backend baseline"
    );
  });

  test("allocates disposable SQLite smoke paths on demand", () => {
    const config = loadPlaygroundConfig({}, [
      "--backend",
      "sqlite",
      "--sqlite-path",
      "auto",
    ]);

    expect(config.backend).toBe("sqlite");
    expect(config.sqlitePath?.startsWith(tmpdir())).toBe(true);
    expect(config.sqlitePath?.includes("tuvren-playground-")).toBe(true);
    expect(config.sqlitePath?.endsWith(".sqlite")).toBe(true);
  });

  test("runs every non-reload fixture scenario under the memory backend", async () => {
    for (const scenario of DEFAULT_PLAYGROUND_SCENARIOS) {
      if (scenario === "reload") {
        continue;
      }

      const report = await runPlaygroundScenario({
        backend: "memory",
        providerMode: "fixture",
        scenario,
      });

      expect(report.scenario).toBe(scenario);
      expectScenarioChecksPassed(report.checks);
    }
  });

  test("runs the streaming scenario through canonical, SSE, and AG-UI outputs", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.checks.completed).toBe(true);
    expect(report.events.canonicalTypes).toContain("turn.start");
    expect(report.events.sseEvents).toContain("turn.start");
    expect(report.events.aguiTypes.length).toBeGreaterThan(0);
  });

  test("emits telemetry evidence using the generated runtime vocabulary", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    expect(report.telemetry.schemaUrl).toBe(
      TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL
    );
    expect(report.telemetry.observedKeys.length).toBeGreaterThan(0);

    for (const key of report.telemetry.observedKeys) {
      expect(TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS).toContain(key);
    }

    expect(report.telemetry.attributes["tuvren.runtime.backend.id"]).toBe(
      "memory"
    );
    expect(report.telemetry.attributes["tuvren.runtime.provider.id"]).toBe(
      "fixture"
    );
    expect(report.telemetry.attributes["tuvren.runtime.branch.id"]).toBe(
      report.thread.branchId
    );
  });

  test("runs approval pause and edited approval resume", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "approval",
    });

    expectScenarioChecksPassed(report.checks);
    expect(report.checks.approvalRequested).toBe(true);
    expect(report.checks.approvalResolved).toBe(true);
    expect(report.checks.resumedCompleted).toBe(true);
    expect(report.events.canonicalTypes).toContain("approval.requested");
    expect(report.events.canonicalTypes).toContain("approval.resolved");
  });

  test("runs AI SDK mock provider mode without credentials", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "ai-sdk-mock",
      scenario: "metadata",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.providerMode).toBe("ai-sdk-mock");
    expect(report.events.canonicalTypes).toContain("message.done");
  });

  test("creates the Gemini playground host when a key is present", () => {
    withTemporaryEnv(
      {
        GEMINI_API_KEY: "test-gemini-key",
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      () => {
        let thrownError: unknown;

        try {
          createPlaygroundHost({
            backend: "memory",
            modelId: "gemini-2.5-flash",
            providerMode: "ai-sdk-google",
            scenario: "streaming",
          });
        } catch (error: unknown) {
          thrownError = error;
        }

        expect(thrownError === undefined).toBe(true);
      }
    );
  });

  test("uses parsed Gemini credentials through the tools scenario wrapper", async () => {
    const config = loadPlaygroundConfig(
      {
        GEMINI_API_KEY: "gemini-key",
        TUVREN_PLAYGROUND_PROVIDER_MODE: "ai-sdk-google",
        TUVREN_PLAYGROUND_SCENARIO: "tools",
      },
      []
    );
    const previousFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (_input, _init) => {
      fetchCalled = true;
      return Promise.reject(new Error("playground test fetch sentinel"));
    };
    try {
      await withTemporaryEnvAsync(
        {
          GEMINI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          const report = await runPlaygroundScenario(config);

          expect(fetchCalled).toBe(true);
          expect(report.status.phase).toBe("failed");
          expect(report.error?.message).toContain(
            "playground test fetch sentinel"
          );
        }
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("rejects the Gemini playground host when no key is present", async () => {
    await withTemporaryEnvAsync(
      {
        GEMINI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        let actualMessage: string | undefined;

        try {
          await runPlaygroundScenario({
            backend: "memory",
            modelId: "gemini-2.5-flash",
            providerMode: "ai-sdk-google",
            scenario: "streaming",
          });
        } catch (error: unknown) {
          actualMessage =
            error instanceof Error ? error.message : String(error);
        }

        expect(actualMessage).toBe(
          "ai-sdk-google playground provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
        );
      }
    );
  });

  test("runs steering through the host control path", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "steering",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.events.canonicalTypes).toContain("steering.incorporated");
  });

  test("aggregates matrix success for deterministic scenarios", async () => {
    const report = await runPlaygroundScenarioMatrix({
      config: {
        backend: "memory",
        modelId: undefined,
        providerMode: "fixture",
        sqlitePath: undefined,
      },
      scenarios: ["streaming", "structured"],
    });

    expect(report.summary.allChecksPassed).toBe(true);
    expect(report.summary.failedScenarios).toEqual([]);
    expect(report.summary.passedScenarioCount).toBe(2);
    expect(report.reports.length).toBe(2);
    expect(report.scenarios).toEqual(["streaming", "structured"]);
    expect(haveAllChecksPassed(report.reports[0]?.checks ?? {})).toBe(true);
  });

  test("treats empty check sets as failed matrix state", () => {
    expect(haveAllChecksPassed({})).toBe(false);
  });

  test("aggregates matrix failures for reload on memory", async () => {
    const report = await runPlaygroundScenarioMatrix({
      config: {
        backend: "memory",
        modelId: undefined,
        providerMode: "fixture",
        sqlitePath: undefined,
      },
      scenarios: ["reload"],
    });

    expect(DEFAULT_GEMINI_PLAYGROUND_SCENARIOS).toContain("approval");
    expect(report.summary.allChecksPassed).toBe(false);
    expect(report.summary.failedScenarioCount).toBe(1);
    expect(report.summary.failedScenarios).toEqual(["reload"]);
  });

  test("playground inspector tolerates schemas without messages or runtime.status paths", async () => {
    const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
    const schemaId = await kernel.schema.register({
      incorporationRules: [],
      paths: [{ collection: "single", path: "context.manifest" }],
      schemaId: "schema_playground_custom",
    });
    const thread = await kernel.thread.create(
      "thread_playground_custom",
      schemaId,
      "branch_playground_custom"
    );
    const inspector = createPlaygroundKernelInspector(kernel);

    expect(await inspector.readBranchMessages(thread.branchId)).toEqual([]);
    expect(await inspector.readBranchStatus(thread.branchId)).toEqual(null);
  });
});
