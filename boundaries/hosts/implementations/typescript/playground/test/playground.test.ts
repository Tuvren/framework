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
import { LLMock } from "@copilotkit/aimock";
import {
  DEFAULT_PLAYGROUND_SCENARIOS,
  loadPlaygroundConfig,
  type PlaygroundScenarioReport,
  runPlaygroundScenario,
} from "@tuvren/playground-host";

describe("playground host scenarios", () => {
  test("loads deterministic default configuration", () => {
    const config = loadPlaygroundConfig({}, []);

    expect(config).toEqual({
      aimockBaseUrl: undefined,
      backend: "memory",
      providerMode: "fixture",
      scenario: "streaming",
      sqlitePath: undefined,
    });
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
          return request.messages.some((message) => message.role === "tool");
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
        requests.some((request) =>
          request.body?.messages.some((message) => message.role === "tool")
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
          return request.messages.some((message) => message.role === "tool");
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
        requests.some((request) =>
          request.body?.messages.some((message) => message.role === "tool")
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
});

function expectScenarioChecksPassed(
  checks: Record<string, boolean | number | string>
): void {
  for (const [name, value] of Object.entries(checks)) {
    expect(`${name}:${String(value === false)}`).toBe(`${name}:false`);
  }
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
