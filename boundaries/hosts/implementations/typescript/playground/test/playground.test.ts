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
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import {
  AIMOCK_PLAYGROUND_PROVIDER_MODES,
  createPlaygroundHost,
  DEFAULT_GEMINI_PLAYGROUND_SCENARIOS,
  DEFAULT_PLAYGROUND_SCENARIOS,
  haveAllChecksPassed,
  loadPlaygroundConfig,
  type PlaygroundProviderMode,
  type PlaygroundScenarioReport,
  runPlaygroundScenario,
  runPlaygroundScenarioMatrix,
} from "@tuvren/playground-host";
import {
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
} from "@tuvren/runtime-core";

const AIMOCK_PROVIDER_CASES: readonly AimockProviderCase[] = [
  {
    expectedCompletionPath: "/v1/chat/completions",
    id: "openai",
    metadataModelId: "gpt-4o-mini",
    mode: "aimock-openai",
    modelId: "gpt-4o-mini",
  },
  {
    expectedCompletionPath: "/v1/messages",
    id: "anthropic",
    metadataModelId: "claude-3-5-haiku-latest",
    mode: "aimock-anthropic",
    modelId: "claude-3-5-haiku-latest",
  },
  {
    expectedCompletionPath:
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    expectedQuerySuffix: "?alt=sse",
    id: "google",
    metadataModelId: "gemini-2.5-flash",
    mode: "aimock-google",
    modelId: "gemini-2.5-flash",
  },
];

interface AimockProviderCase {
  expectedCompletionPath: string;
  expectedQuerySuffix?: string;
  id: "anthropic" | "google" | "openai";
  metadataModelId: string;
  mode: Extract<PlaygroundProviderMode, `aimock-${string}`>;
  modelId: string;
}

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
        // Reload is the one scenario whose evidence must cross a fresh durable
        // host, so the Node-backed SQLite smoke target owns that path.
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

  test("runs streamed text through aimock over the AI SDK OpenAI provider boundary", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    mock.onMessage("Run streaming", {
      content: "aimock streaming complete",
      id: "aimock-chat-response",
      model: "gpt-4o-mini",
      usage: {
        completion_tokens: 3,
        prompt_tokens: 7,
        total_tokens: 10,
      },
    });

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "streaming",
      });
      const request = mock.getLastRequest();

      expect(report.status.phase).toBe("completed");
      expectScenarioChecksPassed(report.checks);
      expect(report.providerMode).toBe("aimock-openai");
      expectSurfaceCoverage(report, {
        aguiTypes: [
          "RUN_STARTED",
          "TEXT_MESSAGE_START",
          "TEXT_MESSAGE_CONTENT",
          "TEXT_MESSAGE_END",
          "RUN_FINISHED",
        ],
        canonicalTypes: [
          "turn.start",
          "state.checkpoint",
          "state.snapshot",
          "iteration.start",
          "message.start",
          "text.delta",
          "text.done",
          "message.done",
          "iteration.end",
          "turn.end",
        ],
      });
      expect(request?.path).toBe("/v1/chat/completions");
      expect(request?.body?.stream).toBe(true);
      expect(request?.response.status).toBe(200);
      expect(request?.response.fixture === null).toBe(false);
    } finally {
      await mock.stop();
    }
  });

  test("runs structured output through aimock and validates the framework projection", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    // aimock's onJsonOutput helper currently matches json_object only. The AI
    // SDK OpenAI provider emits json_schema for structured requests, so this
    // fixture names that wire-level shape explicitly.
    mock.on(
      {
        responseFormat: "json_schema",
        userMessage: "Run structured",
      },
      {
        content: {
          scenario: "structured",
          status: "ready",
        },
      }
    );

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "structured",
      });
      const request = mock.getLastRequest();

      expect(report.status.phase).toBe("completed");
      expectScenarioChecksPassed(report.checks);
      expectSurfaceCoverage(report, {
        aguiTypes: ["RUN_STARTED", "CUSTOM", "RUN_FINISHED"],
        canonicalTypes: [
          "structured.delta",
          "structured.done",
          "message.done",
          "turn.end",
        ],
      });
      expect(request?.body?.response_format?.type).toBe("json_schema");
      assertStructuredResponseFormat(request?.body?.response_format);
      expect(request?.response.status).toBe(200);
    } finally {
      await mock.stop();
    }
  });

  test("runs tool continuation through aimock and host-owned tool execution", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    mock.on(
      {
        sequenceIndex: 0,
        userMessage: "Run tools",
      },
      {
        toolCalls: [
          {
            arguments: {
              query: "docs",
            },
            id: "aimock-call-search",
            name: "search",
          },
        ],
      }
    );
    mock.on(
      {
        predicate(request) {
          return hasSearchToolContinuation(request);
        },
      },
      {
        content: "aimock observed host tool result",
      }
    );

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "tools",
      });
      const requests = mock.getRequests();

      expect(report.status.phase).toBe("completed");
      expectScenarioChecksPassed(report.checks);
      expectSurfaceCoverage(report, {
        aguiTypes: [
          "TOOL_CALL_START",
          "TOOL_CALL_ARGS",
          "TOOL_CALL_END",
          "TOOL_CALL_RESULT",
          "TEXT_MESSAGE_CONTENT",
          "RUN_FINISHED",
        ],
        canonicalTypes: [
          "tool_call.start",
          "tool_call.args_delta",
          "tool_call.done",
          "tool.start",
          "tool.result",
          "text.done",
          "turn.end",
        ],
      });
      expect(requests.length).toBe(2);
      expect(requests.some((request) => request.body?.stream === true)).toBe(
        true
      );
      expect(
        requests.some(
          (request) =>
            request.body !== null && hasSearchToolContinuation(request.body)
        )
      ).toBe(true);
    } finally {
      await mock.stop();
    }
  });

  test("runs approval pause and edited approval resume through aimock", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    mock.on(
      {
        sequenceIndex: 0,
        userMessage: "Run approval",
      },
      {
        toolCalls: [
          {
            arguments: {
              query: "latest status",
            },
            id: "aimock-call-search",
            name: "search",
          },
          {
            arguments: {
              subject: "Status update",
              to: "ops@example.com",
            },
            id: "aimock-call-email",
            name: "email",
          },
        ],
      }
    );
    mock.on(
      {
        predicate(request) {
          return hasApprovalToolContinuation(request);
        },
      },
      {
        content: "aimock approval continuation complete",
      }
    );

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "approval",
      });
      const requests = mock.getRequests();

      expect(report.status.phase).toBe("completed");
      expectScenarioChecksPassed(report.checks);
      expectSurfaceCoverage(report, {
        aguiTypes: [
          "TOOL_CALL_START",
          "TOOL_CALL_ARGS",
          "TOOL_CALL_END",
          "TOOL_CALL_RESULT",
          "CUSTOM",
          "RUN_FINISHED",
        ],
        canonicalTypes: [
          "tool_call.start",
          "tool_call.args_delta",
          "tool_call.done",
          "tool.start",
          "tool.result",
          "approval.requested",
          "approval.resolved",
          "text.done",
          "turn.end",
        ],
      });
      expect(requests.length).toBe(2);
      expect(
        requests.some(
          (request) =>
            request.body !== null && hasApprovalToolContinuation(request.body)
        )
      ).toBe(true);
    } finally {
      await mock.stop();
    }
  });

  test("preserves aimock response metadata through durable runtime evidence", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    mock.onMessage("Run metadata", {
      content: "aimock metadata preserved",
      id: "aimock-metadata-response",
      model: "gpt-4o-mini",
      usage: {
        completion_tokens: 2,
        prompt_tokens: 4,
        total_tokens: 6,
      },
    });

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "metadata",
      });

      expect(report.status.phase).toBe("completed");
      expectScenarioChecksPassed(report.checks);
      expect(report.checks.metadataObserved).toBe(true);
      expectSurfaceCoverage(report, {
        aguiTypes: ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"],
        canonicalTypes: ["text.done", "message.done", "turn.end"],
      });
    } finally {
      await mock.stop();
    }
  });

  test("cancels an aimock-backed multi-iteration turn", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    mock.on(
      {
        sequenceIndex: 0,
        userMessage: "Run cancellation",
      },
      {
        content: "first cancellation iteration",
      }
    );
    mock.on(
      {
        sequenceIndex: 1,
        userMessage: "Run cancellation",
      },
      {
        content: "second cancellation iteration",
      },
      {
        latency: 200,
      }
    );

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "cancel",
      });
      const requests = mock.getRequests();

      expect(report.status.phase).toBe("failed");
      expectScenarioChecksPassed(report.checks);
      expectSurfaceCoverage(report, {
        aguiTypes: ["RUN_STARTED", "RUN_ERROR"],
        canonicalTypes: ["iteration.start", "error", "turn.end"],
      });
      expect(requests.length).toBe(2);
    } finally {
      await mock.stop();
    }
  });

  test("surfaces aimock provider errors as failed runtime turns", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });
    mock.nextRequestError(500, {
      code: "aimock_failure",
      message: "forced aimock provider failure",
      type: "server_error",
    });

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "streaming",
      });
      const request = mock.getLastRequest();

      expect(report.status.phase).toBe("failed");
      expect(report.checks.completed).toBe(false);
      expectSurfaceCoverage(report, {
        aguiTypes: ["RUN_STARTED", "RUN_ERROR"],
        canonicalTypes: ["error", "turn.end"],
      });
      expect(request?.response.status).toBe(500);
    } finally {
      await mock.stop();
    }
  });

  test("surfaces malformed aimock responses as failed runtime turns", async () => {
    const mock = new LLMock({
      chaos: {
        malformedRate: 1,
      },
      logLevel: "silent",
      port: 0,
    });
    mock.onMessage("Run streaming", {
      content: "this response will be replaced by malformed chaos",
    });

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "streaming",
      });
      const request = mock.getLastRequest();

      expect(report.status.phase).toBe("failed");
      expect(report.checks.completed).toBe(false);
      expectSurfaceCoverage(report, {
        aguiTypes: ["RUN_STARTED", "RUN_ERROR"],
        canonicalTypes: ["message.done", "error", "turn.end"],
      });
      expect(request?.response.chaosAction).toBe("malformed");
    } finally {
      await mock.stop();
    }
  });

  test("surfaces unmatched aimock fixtures as failed runtime turns", async () => {
    const mock = new LLMock({
      logLevel: "silent",
      port: 0,
    });

    await mock.start();

    try {
      const report = await runPlaygroundScenario({
        aimockBaseUrl: `${mock.url}/v1`,
        backend: "memory",
        providerMode: "aimock-openai",
        scenario: "streaming",
      });
      const request = mock.getLastRequest();

      expect(report.status.phase).toBe("failed");
      expect(report.checks.completed).toBe(false);
      expectSurfaceCoverage(report, {
        aguiTypes: ["RUN_STARTED", "RUN_ERROR"],
        canonicalTypes: ["error", "turn.end"],
      });
      expect(request?.response.status).toBe(404);
      expect(request?.response.fixture === null).toBe(true);
    } finally {
      await mock.stop();
    }
  });

  test("runs streamed text through aimock over Anthropic and Gemini provider boundaries", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES.filter(
      (entry) => entry.mode !== "aimock-openai"
    )) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      mock.onMessage("Run streaming", {
        content: `${provider.id} aimock streaming complete`,
        id: "aimock-chat-response",
        model: provider.metadataModelId,
        usage: {
          completion_tokens: 3,
          prompt_tokens: 7,
          total_tokens: 10,
        },
      });

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "streaming",
        });
        const request = mock.getLastRequest();

        expect(report.status.phase).toBe("completed");
        expectScenarioChecksPassed(report.checks);
        expect(report.providerMode).toBe(provider.mode);
        expectAimockRequestPath(request?.path, provider);
        expect(request?.response.status).toBe(200);
      } finally {
        await mock.stop();
      }
    }
  });

  test("runs structured output through aimock across Anthropic and Gemini provider boundaries", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES.filter(
      (entry) => entry.mode !== "aimock-openai"
    )) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      registerStructuredFixture(mock, provider);

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "structured",
        });
        const request = mock.getLastRequest();

        expect(report.status.phase).toBe("completed");
        expectScenarioChecksPassed(report.checks);
        expect(report.events.canonicalTypes).toContain("structured.done");
        expectAimockRequestPath(request?.path, provider);
        expect(request?.response.status).toBe(200);
      } finally {
        await mock.stop();
      }
    }
  });

  test("runs tool continuation through aimock across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      mock.on(
        {
          sequenceIndex: 0,
          userMessage: "Run tools",
        },
        {
          model: provider.metadataModelId,
          toolCalls: [
            {
              arguments: {
                query: "docs",
              },
              id: "aimock-call-search",
              name: "search",
            },
          ],
        }
      );
      mock.on(
        {
          predicate(request) {
            return hasSearchToolContinuation(request);
          },
        },
        {
          content: `${provider.id} aimock observed host tool result`,
          model: provider.metadataModelId,
        }
      );

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "tools",
        });
        const requests = mock.getRequests();

        expect(report.status.phase).toBe("completed");
        expectScenarioChecksPassed(report.checks);
        if (provider.mode === "aimock-google") {
          expect(report.checks.toolHistoryPreserved).toBe(true);
          expect(report.checks.toolTraceObserved).toBe(true);
        }
        expect(requests.length).toBe(2);
        expect(
          requests.every((request) =>
            doesAimockRequestPathMatch(request.path, provider)
          )
        ).toBe(true);
        expect(
          requests.some(
            (request) =>
              request.body !== null && hasSearchToolContinuation(request.body)
          )
        ).toBe(true);
      } finally {
        await mock.stop();
      }
    }
  });

  test("runs approval pause and edited approval resume through aimock across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      mock.on(
        {
          sequenceIndex: 0,
          userMessage: "Run approval",
        },
        {
          model: provider.metadataModelId,
          toolCalls: [
            {
              arguments: {
                query: "latest status",
              },
              id: "aimock-call-search",
              name: "search",
            },
            {
              arguments: {
                subject: "Status update",
                to: "ops@example.com",
              },
              id: "aimock-call-email",
              name: "email",
            },
          ],
        }
      );
      mock.on(
        {
          predicate(request) {
            return hasApprovalToolContinuation(request);
          },
        },
        {
          content: `${provider.id} aimock approval continuation complete`,
          model: provider.metadataModelId,
        }
      );

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "approval",
        });
        const requests = mock.getRequests();

        expect(report.status.phase).toBe("completed");
        expectScenarioChecksPassed(report.checks);
        if (provider.mode === "aimock-google") {
          expect(report.checks.toolMetadataHistoryPreserved).toBe(true);
          expect(report.checks.toolMetadataObserved).toBe(true);
        }
        expect(requests.length).toBe(2);
        expect(
          requests.every((request) =>
            doesAimockRequestPathMatch(request.path, provider)
          )
        ).toBe(true);
        expect(
          requests.some(
            (request) =>
              request.body !== null && hasApprovalToolContinuation(request.body)
          )
        ).toBe(true);
      } finally {
        await mock.stop();
      }
    }
  });

  test("preserves aimock response metadata across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      mock.onMessage("Run metadata", {
        content: `${provider.id} aimock metadata preserved`,
        id: "aimock-metadata-response",
        model: provider.metadataModelId,
        usage: {
          completion_tokens: 2,
          prompt_tokens: 4,
          total_tokens: 6,
        },
      });

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "metadata",
        });
        const request = mock.getLastRequest();

        expect(report.status.phase).toBe("completed");
        expectScenarioChecksPassed(report.checks);
        expect(report.checks.metadataObserved).toBe(true);
        expectAimockRequestPath(request?.path, provider);
      } finally {
        await mock.stop();
      }
    }
  });

  test("cancels an aimock-backed multi-iteration turn across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      mock.on(
        {
          sequenceIndex: 0,
          userMessage: "Run cancellation",
        },
        {
          content: `${provider.id} first cancellation iteration`,
          model: provider.metadataModelId,
        }
      );
      mock.on(
        {
          sequenceIndex: 1,
          userMessage: "Run cancellation",
        },
        {
          content: `${provider.id} second cancellation iteration`,
          model: provider.metadataModelId,
        },
        {
          latency: 200,
        }
      );

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "cancel",
        });
        const requests = mock.getRequests();

        expect(report.status.phase).toBe("failed");
        expectScenarioChecksPassed(report.checks);
        expect(requests.length).toBe(2);
        expect(
          requests.every((request) =>
            doesAimockRequestPathMatch(request.path, provider)
          )
        ).toBe(true);
      } finally {
        await mock.stop();
      }
    }
  });

  test("surfaces aimock provider errors across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });
      mock.nextRequestError(500, {
        code: "aimock_failure",
        message: "forced aimock provider failure",
        type: "server_error",
      });

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "streaming",
        });
        const request = mock.getLastRequest();

        expect(report.status.phase).toBe("failed");
        expect(report.checks.completed).toBe(false);
        expectAimockRequestPath(request?.path, provider);
        expect(request?.response.status).toBe(500);
      } finally {
        await mock.stop();
      }
    }
  });

  test("surfaces malformed aimock responses across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        chaos: {
          malformedRate: 1,
        },
        logLevel: "silent",
        port: 0,
      });
      mock.onMessage("Run streaming", {
        content: `${provider.id} malformed response replacement`,
        model: provider.metadataModelId,
      });

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "streaming",
        });
        const request = mock.getLastRequest();

        expect(report.status.phase).toBe("failed");
        expect(report.checks.completed).toBe(false);
        expectAimockRequestPath(request?.path, provider);
        expect(request?.response.chaosAction).toBe("malformed");
      } finally {
        await mock.stop();
      }
    }
  });

  test("surfaces unmatched aimock fixtures across all provider families", async () => {
    for (const provider of AIMOCK_PROVIDER_CASES) {
      const mock = new LLMock({
        logLevel: "silent",
        port: 0,
      });

      await mock.start();

      try {
        const report = await runPlaygroundScenario({
          aimockBaseUrl: createAimockBaseUrl(mock.url, provider.mode),
          backend: "memory",
          providerMode: provider.mode,
          scenario: "streaming",
        });
        const request = mock.getLastRequest();

        expect(report.status.phase).toBe("failed");
        expect(report.checks.completed).toBe(false);
        expectAimockRequestPath(request?.path, provider);
        expect(request?.response.status).toBe(404);
        expect(request?.response.fixture === null).toBe(true);
      } finally {
        await mock.stop();
      }
    }
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
});

function expectScenarioChecksPassed(checks: Record<string, boolean>): void {
  for (const [name, value] of Object.entries(checks)) {
    expect(`${name}:${String(value)}`).toBe(`${name}:true`);
  }
}

function createAimockBaseUrl(
  mockUrl: string,
  providerMode: AimockProviderCase["mode"]
): string {
  switch (providerMode) {
    case "aimock-openai":
    case "aimock-anthropic":
      return `${mockUrl}/v1`;
    case "aimock-google":
      return `${mockUrl}/v1beta`;
    default:
      throw new Error(`unsupported aimock provider mode "${providerMode}"`);
  }
}

function registerStructuredFixture(
  mock: LLMock,
  provider: AimockProviderCase
): void {
  if (provider.mode === "aimock-anthropic") {
    mock.on(
      {
        userMessage: "Run structured",
      },
      {
        model: provider.metadataModelId,
        toolCalls: [
          {
            arguments: {
              scenario: "structured",
              status: "ready",
            },
            id: "aimock-call-json",
            name: "json",
          },
        ],
      }
    );

    return;
  }

  mock.on(
    {
      userMessage: "Run structured",
    },
    {
      content: {
        scenario: "structured",
        status: "ready",
      },
      model: provider.metadataModelId,
    }
  );
}

function expectAimockRequestPath(
  path: string | undefined,
  provider: AimockProviderCase
): void {
  expect(doesAimockRequestPathMatch(path, provider)).toBe(true);
}

function doesAimockRequestPathMatch(
  path: string | undefined,
  provider: AimockProviderCase
): boolean {
  if (typeof path !== "string") {
    return false;
  }

  const [pathname, query = ""] = path.split("?");

  return (
    pathname === provider.expectedCompletionPath &&
    `?${query}` === (provider.expectedQuerySuffix ?? "?")
  );
}

function expectSurfaceCoverage(
  report: PlaygroundScenarioReport,
  expected: {
    aguiTypes: readonly string[];
    canonicalTypes: readonly string[];
  }
): void {
  expect(report.events.sseEvents).toEqual(report.events.canonicalTypes);

  for (const type of expected.canonicalTypes) {
    expect(report.events.canonicalTypes).toContain(type);
    expect(report.events.sseEvents).toContain(type);
  }

  for (const type of expected.aguiTypes) {
    expect(report.events.aguiTypes).toContain(type);
  }
}

function assertStructuredResponseFormat(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new Error("structured response_format was not an object");
  }

  const jsonSchema = value.json_schema;

  if (!isPlainRecord(jsonSchema)) {
    throw new Error("structured response_format.json_schema was not an object");
  }

  const schema = jsonSchema.schema;

  if (!isPlainRecord(schema)) {
    throw new Error("structured response_format.json_schema.schema missing");
  }

  const properties = schema.properties;

  expect(jsonSchema.name).toBe("playground_summary");
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["scenario", "status"]);
  expect(isPlainRecord(properties)).toBe(true);

  if (!isPlainRecord(properties)) {
    throw new Error("structured schema properties missing");
  }

  expect(properties.scenario).toEqual({ type: "string" });
  expect(properties.status).toEqual({ type: "string" });
}

function hasSearchToolContinuation(request: ChatCompletionRequest): boolean {
  const assistantToolCall = findAssistantToolCall(request, "search");
  const toolMessage = findToolMessageForCall(
    request,
    assistantToolCall?.id,
    "search"
  );

  if (assistantToolCall === undefined || toolMessage === undefined) {
    return false;
  }

  const args = parseJsonRecord(assistantToolCall.function.arguments);
  const output = parseToolMessageOutput(toolMessage.content);
  const hits = output?.hits;

  // Match both the model-authored tool input and the host-authored tool output
  // so the fixture cannot pass on an unrelated tool message in the second call.
  return (
    args?.query === "docs" &&
    output?.query === "docs" &&
    Array.isArray(hits) &&
    hits.some(
      (hit) =>
        isPlainRecord(hit) &&
        hit.title === "Tuvren Runtime" &&
        hit.url === "https://example.invalid/tuvren"
    )
  );
}

function hasApprovalToolContinuation(request: ChatCompletionRequest): boolean {
  const searchCall = findAssistantToolCall(request, "search");
  const emailCall = findAssistantToolCall(request, "email");
  const searchMessage = findToolMessageForCall(
    request,
    searchCall?.id,
    "search"
  );
  const emailMessage = findToolMessageForCall(request, emailCall?.id, "email");
  const searchArgs = parseJsonRecord(searchCall?.function.arguments);
  const emailArgs = parseJsonRecord(emailCall?.function.arguments);
  const searchOutput =
    searchMessage === undefined
      ? undefined
      : parseToolMessageOutput(searchMessage.content);
  const emailOutput =
    emailMessage === undefined
      ? undefined
      : parseToolMessageOutput(emailMessage.content);
  const searchHits = searchOutput?.hits;
  const emailResult = emailOutput?.result;
  const approval = emailOutput?.approval;
  const editedInput = isPlainRecord(approval)
    ? approval.editedInput
    : undefined;
  const originalInput = isPlainRecord(approval)
    ? approval.originalInput
    : undefined;

  // Approval resume must prove that the model's original tool request ran
  // through host approval editing, and that the durable continuation includes
  // the host-authored audit payload rather than an unrelated tool message.
  return (
    searchMessage !== undefined &&
    emailMessage !== undefined &&
    searchArgs?.query === "latest status" &&
    emailArgs?.to === "ops@example.com" &&
    emailArgs.subject === "Status update" &&
    searchOutput?.query === "latest status" &&
    Array.isArray(searchHits) &&
    searchHits.some(
      (hit) =>
        isPlainRecord(hit) &&
        hit.title === "Tuvren Runtime" &&
        hit.url === "https://example.invalid/tuvren"
    ) &&
    isPlainRecord(emailResult) &&
    emailResult.sent === true &&
    emailResult.to === "ops@example.com" &&
    isPlainRecord(approval) &&
    approval.type === "edit" &&
    isPlainRecord(editedInput) &&
    editedInput.to === "ops@example.com" &&
    editedInput.subject === "Edited status update" &&
    isPlainRecord(originalInput) &&
    originalInput.to === "ops@example.com" &&
    originalInput.subject === "Status update"
  );
}

function findAssistantToolCall(
  request: ChatCompletionRequest,
  name: string
):
  | NonNullable<ChatCompletionRequest["messages"][number]["tool_calls"]>[number]
  | undefined {
  return request.messages
    .flatMap((message) => message.tool_calls ?? [])
    .find((toolCall) => toolCall.function.name === name);
}

function findToolMessageForCall(
  request: ChatCompletionRequest,
  toolCallId: string | undefined,
  toolName: string
): { content: string } | undefined {
  for (const message of request.messages) {
    if (
      isPlainRecord(message) &&
      message.role === "tool" &&
      typeof message.content === "string"
    ) {
      if (toolCallId !== undefined && message.tool_call_id === toolCallId) {
        return { content: message.content };
      }

      const output = parseJsonRecord(message.content);

      if (output?.name === toolName) {
        return { content: message.content };
      }
    }
  }

  return undefined;
}

function expectPlaygroundConfigError(
  loadConfig: () => unknown,
  expectedMessage: string
): void {
  let actualMessage: string | undefined;

  try {
    loadConfig();
  } catch (error: unknown) {
    actualMessage = error instanceof Error ? error.message : String(error);
  }

  expect(actualMessage).toBe(expectedMessage);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);

    return isPlainRecord(parsed) ? parsed : undefined;
  } catch (_error: unknown) {
    return undefined;
  }
}

function parseToolMessageOutput(
  value: string
): Record<string, unknown> | undefined {
  const parsed = parseJsonRecord(value);

  if (!isPlainRecord(parsed)) {
    return undefined;
  }

  return isPlainRecord(parsed.content) ? parsed.content : parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTemporaryEnv(
  overrides: Record<string, string | undefined>,
  run: () => void
): void {
  const previousEntries = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousEntries.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    run();
  } finally {
    restoreEnvironment(previousEntries);
  }
}

async function withTemporaryEnvAsync(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const previousEntries = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousEntries.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    await run();
  } finally {
    restoreEnvironment(previousEntries);
  }
}

function restoreEnvironment(entries: Map<string, string | undefined>): void {
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
