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

import { expect } from "bun:test";
import type { ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import type {
  PlaygroundProviderMode,
  PlaygroundScenarioReport,
} from "@tuvren/playground-host";

export const AIMOCK_PROVIDER_CASES: readonly AimockProviderCase[] = [
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
] as const;

export interface AimockProviderCase {
  expectedCompletionPath: string;
  expectedQuerySuffix?: string;
  id: "anthropic" | "google" | "openai";
  metadataModelId: string;
  mode: Extract<PlaygroundProviderMode, `aimock-${string}`>;
  modelId: string;
}

export function expectScenarioChecksPassed(
  checks: Record<string, boolean>
): void {
  for (const [name, value] of Object.entries(checks)) {
    expect(`${name}:${String(value)}`).toBe(`${name}:true`);
  }
}

export function createAimockBaseUrl(
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

export function registerStructuredFixture(
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

export function expectAimockRequestPath(
  path: string | undefined,
  provider: AimockProviderCase
): void {
  expect(doesAimockRequestPathMatch(path, provider)).toBe(true);
}

export function doesAimockRequestPathMatch(
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

export function expectSurfaceCoverage(
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

export function assertStructuredResponseFormat(value: unknown): void {
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

export function hasSearchToolContinuation(
  request: ChatCompletionRequest
): boolean {
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

export function hasApprovalToolContinuation(
  request: ChatCompletionRequest
): boolean {
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

export function expectPlaygroundConfigError(
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

export function withTemporaryEnv(
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

export async function withTemporaryEnvAsync(
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

function restoreEnvironment(entries: Map<string, string | undefined>): void {
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
