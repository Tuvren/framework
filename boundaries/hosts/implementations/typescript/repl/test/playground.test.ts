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
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  AIMOCK_REPL_PROVIDER_MODES as AIMOCK_PLAYGROUND_PROVIDER_MODES,
  createReplHost as createPlaygroundHost,
  createReplShell,
  DEFAULT_GEMINI_REPL_SCENARIOS as DEFAULT_GEMINI_PLAYGROUND_SCENARIOS,
  DEFAULT_REPL_SCENARIOS as DEFAULT_PLAYGROUND_SCENARIOS,
  haveAllChecksPassed,
  loadReplConfig as loadPlaygroundConfig,
  runReplScenario as runPlaygroundScenario,
  runReplScenarioMatrix as runPlaygroundScenarioMatrix,
  runReplCommand,
  runReplInput,
} from "@tuvren/repl-host";
import {
  createRuntimeKernel,
  TUVREN_RUNTIME_TELEMETRY_ATTRIBUTE_KEYS,
  TUVREN_RUNTIME_TELEMETRY_SCHEMA_URL,
  type TuvrenPrompt,
  type TuvrenToolDefinition,
  type TuvrenProvider,
} from "@tuvren/runtime";
import { createPlaygroundKernelInspector } from "../src/lib/playground-kernel.js";
import { withHead } from "../src/lib/playground-scenarios-support.js";
import {
  createPlaygroundTools,
  textSignal,
} from "../src/lib/playground-tools.js";
import { readShellTextArgument } from "../src/lib/repl-shell.js";
import {
  expectPlaygroundConfigError,
  expectScenarioChecksPassed,
  withTemporaryEnv,
  withTemporaryEnvAsync,
} from "./playground-test-helpers.ts";
import { createLiveTurnWriter } from "../src/lib/repl-live-output.js";

describe("repl host scenarios", () => {
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
      systemPrompt: undefined,
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

  test("loads REPL-prefixed env aliases", () => {
    const config = loadPlaygroundConfig(
      {
        TUVREN_REPL_AIMOCK_BASE_URL: "http://127.0.0.1:4012/v1",
        TUVREN_REPL_KERNEL_GRPC_BASE_URL: "http://127.0.0.1:50053",
        TUVREN_REPL_KERNEL_MODE: "rust-grpc",
        TUVREN_REPL_PROVIDER_MODE: "aimock-openai",
        TUVREN_REPL_SCENARIO: "metadata",
        TUVREN_REPL_SYSTEM_PROMPT: "Be concise.",
      },
      []
    );

    expect(config.aimockBaseUrl).toBe("http://127.0.0.1:4012/v1");
    expect(config.kernelGrpcBaseUrl).toBe("http://127.0.0.1:50053");
    expect(config.kernelMode).toBe("rust-grpc");
    expect(config.providerMode).toBe("aimock-openai");
    expect(config.scenario).toBe("metadata");
    expect(config.systemPrompt).toBe("Be concise.");
  });

  test("loads playground system-instructions alias", () => {
    const config = loadPlaygroundConfig(
      {
        TUVREN_PLAYGROUND_SYSTEM_INSTRUCTIONS: "Prefer bullet points.",
      },
      []
    );

    expect(config.systemPrompt).toBe("Prefer bullet points.");
  });

  test("rejects unsupported REPL options before configuration is loaded", () => {
    expectPlaygroundConfigError(
      () => loadPlaygroundConfig({}, ["--bogus", "value"]),
      "unsupported repl option --bogus"
    );
  });

  test("rejects aimock provider configuration without a usable base URL", () => {
    for (const providerMode of AIMOCK_PLAYGROUND_PROVIDER_MODES) {
      expectPlaygroundConfigError(
        () => loadPlaygroundConfig({}, ["--provider", providerMode]),
        `${providerMode} repl provider requires --aimock-base-url, TUVREN_REPL_AIMOCK_BASE_URL, or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`
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
        `${providerMode} repl provider requires --aimock-base-url, TUVREN_REPL_AIMOCK_BASE_URL, or TUVREN_PLAYGROUND_AIMOCK_BASE_URL`
      );
    }
  });

  test("rejects ai-sdk-google configuration without a usable API key", () => {
    expectPlaygroundConfigError(
      () => loadPlaygroundConfig({}, ["--provider", "ai-sdk-google"]),
      "ai-sdk-google repl provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
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
      "ai-sdk-google repl provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
    );
  });

  test("rejects rust-grpc kernel configuration without a usable base URL", () => {
    expectPlaygroundConfigError(
      () => loadPlaygroundConfig({}, ["--kernel-mode", "rust-grpc"]),
      "rust-grpc repl kernel requires --kernel-grpc-base-url, TUVREN_REPL_KERNEL_GRPC_BASE_URL, or TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL"
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
      "rust-grpc repl kernel requires --kernel-grpc-base-url, TUVREN_REPL_KERNEL_GRPC_BASE_URL, or TUVREN_PLAYGROUND_KERNEL_GRPC_BASE_URL"
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
      "rust-grpc repl kernel currently supports only the memory backend baseline"
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

    globalThis.fetch = Object.assign(
      (
        _input: string | URL | Request,
        _init?: BunFetchRequestInit
      ): Promise<Response> => {
        fetchCalled = true;
        return Promise.reject(new Error("playground test fetch sentinel"));
      },
      {
        preconnect: previousFetch.preconnect,
      }
    );
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
          "ai-sdk-google repl provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
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

  test("runs extension-powered behavior through the host", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "extension",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.checks.extensionEventObserved).toBe(true);
    expect(report.checks.extensionStatePersisted).toBe(true);
    expect(report.events.canonicalTypes).toContain("custom");
  });

  test("runs orchestration through descendant-aware host handles", async () => {
    const report = await runPlaygroundScenario({
      backend: "memory",
      providerMode: "fixture",
      scenario: "orchestration",
    });

    expect(report.status.phase).toBe("completed");
    expectScenarioChecksPassed(report.checks);
    expect(report.checks.descendantEventsObserved).toBe(true);
    expect(report.telemetry.attributes["tuvren.runtime.run.id"]).not.toBe(null);
  });

  test("drives approval and orchestration through the interactive shell commands", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".turn start approval");
    await runReplCommand(shell, ".turn await");

    expect(shell.activeTurn?.handle.status().phase).toBe("paused");

    await runReplCommand(shell, ".turn approve edit");
    await runReplCommand(shell, ".turn await");

    expect(shell.activeTurn).toBe(undefined);
    expect(
      shell.lastProjection?.canonical.some(
        (event) => event.type === "approval.resolved"
      )
    ).toBe(true);
    expect((await runReplCommand(shell, ".turn cancel")).output).toBe(
      "No active turn is currently running."
    );
    const headBeforeOrchestration = shell.thread?.headTurnNodeHash;

    await runReplCommand(shell, ".orch start");
    await runReplCommand(shell, ".orch spawn worker Run proof child");
    await runReplCommand(shell, ".orch await");

    expect(shell.activeOrchestration).toBe(undefined);
    expect(
      shell.lastOrchestrationEvents?.some(
        (event) => event.source?.workerId !== undefined
      )
    ).toBe(true);
    expect(shell.thread?.headTurnNodeHash).not.toBe(headBeforeOrchestration);

    const activeMessages = readCommandArray(
      await runReplCommand(shell, ".messages show")
    );
    expect(activeMessages.length).toBeGreaterThan(0);

    const activeBranchId = shell.thread?.branchId;
    await runReplCommand(shell, ".branch fork");
    expect(shell.thread?.branchId).not.toBe(activeBranchId);

    const forkMessages = readCommandArray(
      await runReplCommand(shell, ".messages show")
    );
    expect(forkMessages.length).toBe(activeMessages.length);
    expect(
      (await runReplCommand(shell, ".orch spawn worker retry")).output
    ).toBe("No active orchestration root exists.");
  });

  test("keeps the active thread head aligned when orchestration emits descendant checkpoints", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    const activeThreadId = shell.thread?.threadId;

    if (activeThreadId === undefined) {
      throw new Error("expected active thread id after .thread new");
    }

    await runReplCommand(shell, ".orch start");
    await runReplCommand(shell, ".orch spawn worker Run proof child");
    await runReplCommand(shell, ".orch await");

    expect(shell.thread?.threadId).toBe(activeThreadId);
    expect(shell.thread?.headTurnNodeHash).not.toBe(
      shell.thread?.rootTurnNodeHash
    );

    const activeMessages = readCommandArray(
      await runReplCommand(shell, ".messages show")
    );
    await runReplCommand(shell, ".branch fork");

    const forkMessages = readCommandArray(
      await runReplCommand(shell, ".messages show")
    );
    expect(forkMessages.length).toBe(activeMessages.length);
  });

  test("shows the last canonical orchestration events through .events show", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".orch start");
    await runReplCommand(shell, ".orch spawn worker Run proof child");
    await runReplCommand(shell, ".orch await");

    const events = readCommandArray(
      await runReplCommand(shell, ".events show")
    ) as Array<{ source?: { workerId?: string } }>;

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.source?.workerId !== undefined)).toBe(
      true
    );
  });

  test("rejects overwriting an active turn and cancels it before backend reset", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".turn start steering");
    const activeHandle = shell.activeTurn?.handle;

    if (activeHandle === undefined) {
      throw new Error("expected active turn handle after .turn start");
    }

    expect((await runReplCommand(shell, ".turn start approval")).output).toBe(
      "Active work already exists on the current branch. Await, approve, steer, or cancel it before starting another turn."
    );
    expect(shell.activeTurn?.handle).toBe(activeHandle);

    await runReplCommand(shell, ".backend memory");

    expect(shell.activeTurn).toBe(undefined);
    await waitForCondition(() => activeHandle.status().phase !== "running");
  });

  test("rejects conflicting orchestration commands and cancels tracked work before thread reset", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".orch start");
    const activeHandle = shell.activeOrchestration?.handle;

    if (activeHandle === undefined) {
      throw new Error("expected active orchestration handle after .orch start");
    }

    expect((await runReplCommand(shell, ".orch start")).output).toBe(
      "Active work already exists on the current branch. Await or cancel it before starting another root orchestration."
    );

    await runReplCommand(shell, ".orch spawn worker first");

    expect(
      (await runReplCommand(shell, ".orch spawn worker second")).output
    ).toBe(
      "A child orchestration handle is already active. Await the current orchestration before spawning another child."
    );

    await runReplCommand(shell, ".thread new");

    expect(shell.activeOrchestration).toBe(undefined);
    await waitForCondition(() => activeHandle.status().phase !== "running");
  });

  test("rejects cross-kind work on the same branch", async () => {
    const turnShell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(turnShell, ".thread new");
    await runReplCommand(turnShell, ".turn start steering");
    const turnHandle = turnShell.activeTurn?.handle;

    if (turnHandle === undefined) {
      throw new Error("expected active turn handle after .turn start");
    }

    expect((await runReplCommand(turnShell, ".orch start")).output).toBe(
      "Active work already exists on the current branch. Await or cancel it before starting another root orchestration."
    );

    await runReplCommand(turnShell, ".backend memory");
    await waitForCondition(() => turnHandle.status().phase !== "running");

    const orchestrationShell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(orchestrationShell, ".thread new");
    await runReplCommand(orchestrationShell, ".orch start");
    const orchestrationHandle = orchestrationShell.activeOrchestration?.handle;

    if (orchestrationHandle === undefined) {
      throw new Error("expected active orchestration handle after .orch start");
    }

    expect(
      (await runReplCommand(orchestrationShell, ".turn start steering")).output
    ).toBe(
      "Active work already exists on the current branch. Await, approve, steer, or cancel it before starting another turn."
    );

    await runReplCommand(orchestrationShell, ".thread new");
    await waitForCondition(
      () => orchestrationHandle.status().phase !== "running"
    );
  });

  test("rejects branching while work is active", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".turn start steering");
    const activeHandle = shell.activeTurn?.handle;
    const activeBranchId = shell.thread?.branchId;

    if (activeHandle === undefined) {
      throw new Error("expected active turn handle after .turn start");
    }

    expect((await runReplCommand(shell, ".branch fork")).output).toBe(
      "Active work already exists on the current branch. Await or cancel it before forking a branch."
    );
    expect(shell.thread?.branchId).toBe(activeBranchId);

    await runReplCommand(shell, ".backend memory");
    await waitForCondition(() => activeHandle.status().phase !== "running");
  });

  test("cancels active work when exiting the shell", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".turn start steering");
    const activeHandle = shell.activeTurn?.handle;

    if (activeHandle === undefined) {
      throw new Error("expected active turn handle after .turn start");
    }

    expect((await runReplCommand(shell, ".exit")).exit).toBe(true);
    await waitForCondition(() => activeHandle.status().phase !== "running");
  });

  test("allows new work immediately after turn cancellation", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".turn start steering");
    const cancelledHandle = shell.activeTurn?.handle;

    if (cancelledHandle === undefined) {
      throw new Error("expected active turn handle after .turn start");
    }

    expect((await runReplCommand(shell, ".turn cancel")).output).toBe(
      "Cancellation requested for the active turn."
    );
    expect(shell.activeTurn).toBe(undefined);
    await waitForCondition(() => cancelledHandle.status().phase !== "running");

    await runReplCommand(shell, ".turn start streaming");
    expect(shell.activeTurn).not.toBe(undefined);
  });

  test("treats plain input as a streamed freeform turn", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });
    const streamedChunks: string[] = [];
    const result = await runReplInput(shell, "approval", {
      onCanonicalEvent(event) {
        if (event.type === "text.delta") {
          streamedChunks.push(event.delta);
        }
      },
    });

    expect(result.output).toBe(undefined);
    expect(streamedChunks.join("")).toBe("Playground streaming complete.");
    expect(shell.activeTurn).toBe(undefined);
    expect(shell.thread).not.toBe(undefined);
    expect(
      shell.lastCanonicalEvents?.some((event) => event.type === "text.delta")
    ).toBe(true);
    expect(
      shell.lastCanonicalEvents?.some(
        (event) => event.type === "approval.requested"
      )
    ).toBe(false);
  });

  test("applies env-driven system prompt to freeform turns", async () => {
    const host = createPlaygroundHost({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
      systemPrompt: "Answer like a strict reviewer.",
    });
    const thread = await host.createThread();
    let observedPrompt: TuvrenPrompt | undefined;
    const provider: TuvrenProvider = {
      async generate(prompt) {
        observedPrompt = prompt;
        return {
          finishReason: "stop",
          parts: [{ text: "ok", type: "text" }],
        };
      },
      id: "test:system-prompt-provider",
      async *stream(prompt) {
        observedPrompt = prompt;
        yield { type: "text_delta", text: "ok" };
        yield { finishReason: "stop", type: "finish" };
      },
    };
    const handle = host.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("hello"),
      threadId: thread.threadId,
    });

    await host.project(handle);

    expect(observedPrompt?.messages[0]).toEqual({
      content: "Answer like a strict reviewer.",
      role: "system",
    });
  });

  test("registers built-in repl tools on freeform turns by default", async () => {
    const host = createPlaygroundHost({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });
    const thread = await host.createThread();
    let observedPrompt: TuvrenPrompt | undefined;
    const provider: TuvrenProvider = {
      async generate(prompt) {
        observedPrompt = prompt;
        return {
          finishReason: "stop",
          parts: [{ text: "ok", type: "text" }],
        };
      },
      id: "test:default-tools-provider",
      async *stream(prompt) {
        observedPrompt = prompt;
        yield { type: "text_delta", text: "ok" };
        yield { finishReason: "stop", type: "finish" };
      },
    };
    const handle = host.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
      },
      signal: textSignal("what can you do?"),
      threadId: thread.threadId,
    });

    await host.project(handle);

    expect(observedPrompt?.tools?.map((tool) => tool.name)).toEqual([
      "search",
      "email",
      "calculator",
      "weather",
    ]);
  });

  test("respects explicit tool overrides for scenario-style turns", async () => {
    const host = createPlaygroundHost({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });
    const thread = await host.createThread();
    const weatherTool = findToolDefinition("weather");
    let observedPrompt: TuvrenPrompt | undefined;
    const provider: TuvrenProvider = {
      async generate(prompt) {
        observedPrompt = prompt;
        return {
          finishReason: "stop",
          parts: [{ text: "ok", type: "text" }],
        };
      },
      id: "test:explicit-tools-provider",
      async *stream(prompt) {
        observedPrompt = prompt;
        yield { type: "text_delta", text: "ok" };
        yield { finishReason: "stop", type: "finish" };
      },
    };
    const handle = host.executeTurn({
      branchId: thread.branchId,
      config: {
        model: provider,
        name: "primary",
        tools: [weatherTool],
      },
      signal: textSignal("weather only"),
      threadId: thread.threadId,
    });

    await host.project(handle);

    expect(observedPrompt?.tools?.map((tool) => tool.name)).toEqual([
      "weather",
    ]);
  });

  test("implements calculator and mock weather repl tools", async () => {
    const calculator = findToolDefinition("calculator");
    const weather = findToolDefinition("weather");

    expect(
      await Promise.resolve(
        calculator.execute({
          operands: [84, 2, 3],
          operation: "divide",
        })
      )
    ).toEqual({
      operands: [84, 2, 3],
      operation: "divide",
      result: 14,
      status: "success",
    });

    expect(
      await Promise.resolve(
        weather.execute({
          location: "Santiago",
          unit: "celsius",
        })
      )
    ).toEqual({
      condition: "windy",
      feelsLike: 3,
      humidityPercent: 72,
      location: "Santiago",
      source: "mock",
      summary: "windy in Santiago",
      temperature: 2,
      unit: "celsius",
      windSpeedKph: 10,
    });
  });

  test("maps paused approval shortcuts to host approval decisions", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });
    const eventTypes: string[] = [];
    const startResult = await runReplInput(shell, ".turn start approval", {
      onCanonicalEvent(event) {
        eventTypes.push(event.type);
      },
    });

    expect(startResult.output).toContain("Turn paused for approval.");
    expect(shell.activeTurn?.handle.status().phase).toBe("paused");

    const approveResult = await runReplInput(shell, "1", {
      onCanonicalEvent(event) {
        eventTypes.push(event.type);
      },
    });

    expect(approveResult.output).toBe(undefined);
    expect(shell.activeTurn).toBe(undefined);
    expect(eventTypes).toContain("approval.requested");
    expect(eventTypes).toContain("approval.resolved");
    expect(eventTypes).toContain("tool.result");
  });

  test("renders streamed thinking and assistant output distinctly", () => {
    const chunks: string[] = [];
    const writer = createLiveTurnWriter((chunk) => {
      chunks.push(chunk);
    });

    writer.observe({
      delta: "Considering the request.",
      messageId: "message-1",
      timestamp: 0,
      type: "reasoning.delta",
    });
    writer.observe({
      messageId: "message-1",
      timestamp: 0,
      type: "reasoning.done",
    });
    writer.observe({
      delta: "Hello from Tuvren.",
      messageId: "message-1",
      timestamp: 0,
      type: "text.delta",
    });
    writer.observe({
      finishReason: "stop",
      messageId: "message-1",
      timestamp: 0,
      type: "message.done",
    });
    writer.finish();

    expect(chunks.join("")).toBe(
      "thinking> Considering the request.\nassistant> Hello from Tuvren.\n"
    );
  });

  test("renders approval, extension, steering, and error events live", () => {
    const chunks: string[] = [];
    const writer = createLiveTurnWriter((chunk) => {
      chunks.push(chunk);
    });

    writer.observe({
      request: {
        completedResults: [],
        toolCalls: [
          {
            callId: "call-1",
            decisions: ["approve", "reject", "edit"],
            input: {
              subject: "Status update",
              to: "ops@example.com",
            },
            message: "Email requires approval.",
            name: "email",
          },
        ],
      },
      timestamp: 0,
      type: "approval.requested",
    });
    writer.observe({
      response: {
        decisions: [
          {
            callId: "call-1",
            type: "approve",
          },
        ],
      },
      timestamp: 0,
      type: "approval.resolved",
    });
    writer.observe({
      name: "proof-extension",
      data: {
        persisted: true,
      },
      timestamp: 0,
      type: "custom",
    });
    writer.observe({
      messageId: "message-1",
      timestamp: 0,
      type: "steering.incorporated",
    });
    writer.observe({
      error: {
        code: "invalid_stream_event",
        message: "driver-emitted assistant event sequences must be complete and match the durable assistant message",
      },
      fatal: true,
      timestamp: 0,
      type: "error",
    });

    expect(chunks.join("")).toBe(
      'approval> 1 approve | 2 reject | 3 edit | pending: email {"subject":"Status update","to":"ops@example.com"}\n' +
        "approval> resolved: approve\n" +
        'event> proof-extension {"persisted":true}\n' +
        "steering> incorporated\n" +
        "error> fatal invalid_stream_event driver-emitted assistant event sequences must be complete and match the durable assistant message\n"
    );
  });

  test("renders tool call and tool result events live in the repl", () => {
    const chunks: string[] = [];
    const writer = createLiveTurnWriter((chunk) => {
      chunks.push(chunk);
    });

    writer.observe({
      callId: "call-1",
      input: {
        operands: [84, 2, 3],
        operation: "divide",
      },
      name: "calculator",
      timestamp: 0,
      type: "tool_call.done",
    });
    writer.observe({
      callId: "call-1",
      name: "calculator",
      output: {
        result: 14,
        status: "success",
      },
      timestamp: 0,
      type: "tool.result",
    });

    expect(chunks.join("")).toBe(
      'tool-call> calculator {"operands":[84,2,3],"operation":"divide"}\n' +
        'tool-result> calculator {"result":14,"status":"success"}\n'
    );
  });

  test("renders ANSI colors when enabled", () => {
    const chunks: string[] = [];
    const writer = createLiveTurnWriter(
      (chunk) => {
        chunks.push(chunk);
      },
      {
        useAnsiColors: true,
      }
    );

    writer.observe({
      delta: "Thinking...",
      messageId: "message-1",
      timestamp: 0,
      type: "reasoning.delta",
    });
    writer.observe({
      messageId: "message-1",
      timestamp: 0,
      type: "reasoning.done",
    });
    writer.observe({
      request: {
        completedResults: [],
        toolCalls: [
          {
            callId: "call-approval",
            decisions: ["approve", "reject", "edit"],
            input: {
              to: "ops@example.com",
            },
            message: "Email requires approval.",
            name: "email",
          },
        ],
      },
      timestamp: 0,
      type: "approval.requested",
    });
    writer.observe({
      data: {
        persisted: true,
      },
      name: "proof-extension",
      timestamp: 0,
      type: "custom",
    });
    writer.observe({
      callId: "call-1",
      input: {
        location: "Santiago",
      },
      name: "weather",
      timestamp: 0,
      type: "tool_call.done",
    });
    writer.observe({
      callId: "call-1",
      isError: true,
      name: "weather",
      output: {
        message: "upstream unavailable",
        status: "error",
      },
      timestamp: 0,
      type: "tool.result",
    });

    expect(chunks.join("")).toContain("\u001B[90mthinking> \u001B[0m");
    expect(chunks.join("")).toContain("\u001B[90mThinking...\u001B[0m");
    expect(chunks.join("")).toContain("\u001B[33mapproval> \u001B[0m");
    expect(chunks.join("")).toContain("\u001B[35mevent> \u001B[0m");
    expect(chunks.join("")).toContain("\u001B[33mtool-call> \u001B[0m");
    expect(chunks.join("")).toContain("\u001B[31mtool-error> \u001B[0m");
  });

  test("resets shell state when the backend command is used", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".turn start streaming");
    await runReplCommand(shell, ".backend memory");

    expect(shell.config.backend).toBe("memory");
    expect(shell.config.sqlitePath).toBe(undefined);
    expect(shell.thread).toBe(undefined);
    expect(shell.activeTurn).toBe(undefined);
    expect(shell.lastProjection).toBe(undefined);
  });

  test("does not create a thread when showing messages without an active thread", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    expect((await runReplCommand(shell, ".messages show")).output).toBe(
      "No active thread exists."
    );
    expect(shell.thread).toBe(undefined);
  });

  test("rejects rust-grpc backend switching to sqlite through the shell", async () => {
    const shell = createReplShell({
      backend: "memory",
      kernelGrpcBaseUrl: "http://127.0.0.1:50051",
      kernelMode: "rust-grpc",
      providerMode: "fixture",
      scenario: "streaming",
    });

    let actualMessage = "";

    try {
      await runReplCommand(shell, ".backend sqlite auto");
    } catch (error: unknown) {
      actualMessage = error instanceof Error ? error.message : String(error);
    }

    expect(actualMessage).toBe(
      "rust-grpc repl kernel currently supports only the memory backend baseline"
    );
  });

  test("preserves quoted sqlite paths when rejoining shell arguments", () => {
    expect(
      readShellTextArgument(['"/tmp/tuvren', "repl", "spaced", 'path.sqlite"'])
    ).toBe("/tmp/tuvren repl spaced path.sqlite");
  });

  test("cancels active orchestration without resetting the shell", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".orch start");
    const activeHandle = shell.activeOrchestration?.handle;

    if (activeHandle === undefined) {
      throw new Error("expected active orchestration handle after .orch start");
    }

    expect((await runReplCommand(shell, ".orch cancel")).output).toBe(
      "Cancellation requested for the active orchestration."
    );
    expect(shell.activeOrchestration).toBe(undefined);
    await waitForCondition(() => activeHandle.status().phase !== "running");
  });

  test("clears failed child orchestration state after await errors", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    await runReplCommand(shell, ".thread new");
    await runReplCommand(shell, ".orch start");
    await runReplCommand(shell, ".orch spawn nope hi");

    let actualMessage = "";

    try {
      await runReplCommand(shell, ".orch await");
    } catch (error: unknown) {
      actualMessage = error instanceof Error ? error.message : String(error);
    }

    expect(actualMessage.length > 0).toBe(true);
    expect(shell.activeOrchestration).toBe(undefined);

    await runReplCommand(shell, ".orch start");
    const recoveryHandle = shell.activeOrchestration?.handle;
    expect(recoveryHandle).not.toBe(undefined);

    expect((await runReplCommand(shell, ".orch cancel")).output).toBe(
      "Cancellation requested for the active orchestration."
    );

    if (recoveryHandle !== undefined) {
      await waitForCondition(() => recoveryHandle.status().phase !== "running");
    }
  });

  test("rejects multi-turn proof scenarios through .turn start", async () => {
    const shell = createReplShell({
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
    });

    expect(
      (await runReplCommand(shell, ".turn start orchestration")).output
    ).toBe(
      'Scenario "orchestration" is not supported through .turn start. Use .orch commands or the scripted scenario runner instead.'
    );
    expect((await runReplCommand(shell, ".turn start branching")).output).toBe(
      'Scenario "branching" is not supported through .turn start. Use the scripted scenario runner instead.'
    );
    expect(shell.activeTurn).toBe(undefined);
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

  test("preserves the previous head when only descendant checkpoints are present", () => {
    const thread = {
      branchId: "branch-1",
      headTurnNodeHash: "head-1",
      rootTurnNodeHash: "root-1",
      rootTurnTreeHash: "tree-1",
      threadId: "thread-1",
    };
    const projection = {
      agui: [],
      canonical: [
        {
          iterationCount: 1,
          source: {
            agent: "worker",
            threadId: "thread-2",
            workerId: "worker-1",
          },
          timestamp: 0,
          turnNodeHash: "child-head-1",
          type: "state.checkpoint",
        },
      ],
      sse: [],
    } satisfies Parameters<typeof withHead>[1];

    expect(withHead(thread, projection).headTurnNodeHash).toBe("head-1");
  });

  test("interactive CLI exits cleanly for piped sessions", async () => {
    for (const stdin of [
      ".thread new\n.exit\n",
      ".turn start streaming\n.exit\n",
      "Hello from the REPL\n.exit\n",
    ]) {
      const result = await runCliSession(stdin);

      expect(result.exitCode).toBe(0);
      expect(result.stderr.includes("ERR_USE_AFTER_CLOSE")).toBe(false);
    }
  });

  test("interactive CLI streams plain-text turns without turn commands", async () => {
    const result = await runCliSession("Hello from the REPL\n.exit\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes("Playground streaming complete.")).toBe(true);
    expect(result.stdout.includes('Unknown command "Hello from the REPL"')).toBe(
      false
    );
  });

  test("interactive CLI honors TUVREN_REPL_SCENARIO aliases", async () => {
    const result = await runCliSession("", {
      TUVREN_REPL_SCENARIO: "streaming",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes('"scenario": "streaming"')).toBe(true);
    expect(result.stdout.includes("Tuvren REPL Host")).toBe(false);
  });

  test("CLI startup failures render a concise single-line error", async () => {
    const result = await runCliProcess({
      argv: ["--bogus", "value"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("unsupported repl option --bogus");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  test("CLI scenario failures render a concise single-line error", async () => {
    const result = await runCliProcess({
      argv: [
        "--backend",
        "memory",
        "--provider",
        "ai-sdk-google",
        "--scenario",
        "streaming",
      ],
      envOverrides: {
        GEMINI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      "ai-sdk-google repl provider requires GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY"
    );
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toBe("");
  });
});

function readCommandArray(
  result: Awaited<ReturnType<typeof runReplCommand>>
): unknown[] {
  if (result.output === undefined) {
    throw new Error("expected command output");
  }

  const parsed: unknown = JSON.parse(result.output);

  if (!Array.isArray(parsed)) {
    throw new Error("expected JSON array output");
  }

  return parsed;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for shell condition");
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

function findToolDefinition(name: string): TuvrenToolDefinition {
  const tool = createPlaygroundTools().find((entry) => entry.name === name);

  if (tool === undefined) {
    throw new Error(`expected repl tool "${name}"`);
  }

  return tool;
}

async function runCliSession(
  stdin: string,
  envOverrides?: Record<string, string>
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return await runCliProcess({
    envOverrides,
    stdin,
  });
}

async function runCliProcess(input: {
  argv?: readonly string[];
  envOverrides?: Record<string, string | undefined>;
  stdin?: string;
}): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const cli = spawn(
    "node",
    [
      join(process.cwd(), "dist/cli.js"),
      ...(input.argv ?? ["--backend", "memory", "--provider", "fixture"]),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        ...input.envOverrides,
      },
      stdio: "pipe",
    }
  );
  let stdout = "";
  let stderr = "";

  cli.stdout.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });
  cli.stderr.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });
  cli.stdin.end(input.stdin ?? "");

  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}
