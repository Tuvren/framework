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
import { LLMock } from "@copilotkit/aimock";
import { runPlaygroundScenario } from "@tuvren/playground-host";
import {
  AIMOCK_PROVIDER_CASES,
  createAimockBaseUrl,
  doesAimockRequestPathMatch,
  expectAimockRequestPath,
  expectScenarioChecksPassed,
  hasApprovalToolContinuation,
  hasSearchToolContinuation,
  registerStructuredFixture,
} from "./playground-test-helpers.ts";

describe("playground host scenarios aimock matrix", () => {
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
});
