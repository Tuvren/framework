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

/**
 * Conformance adapter operations for the framework `secret-isolation` check set
 * (ADR-044, KRT-BD004). Each operation configures representative secrets at the
 * integration edge, drives a real runtime, and returns the RAW observation
 * surfaces (persisted kernel records, captured canonical stream events,
 * captured telemetry, and an in-process recorded transcript) plus the configured
 * secret values. The shared runner-owned `secretAbsence` assertion owns the
 * verdict — this adapter performs no scanning or grading.
 */

import type {
  AttachedClientEndpoint,
  ClientInvocationEnvelope,
  ClientReportedResult,
} from "@tuvren/core/capabilities";
import type {
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import type { TuvrenPrompt } from "@tuvren/provider-api";
import { createAiSdkProviderBridge } from "@tuvren/provider-bridge-ai-sdk";
import {
  createReplTranscriptWriter,
  type ReplTranscriptHeader,
} from "@tuvren/repl-host";
import {
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import type {
  AdapterProjection,
  ConformanceKernelHarness,
} from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  assistantToolCalls,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticRunner,
  RUNNER_ID,
  textSignal,
} from "./framework-adapter-runtime.ts";

interface SecretFixture {
  mcpBearerToken: string;
  mcpHeaderAuth: { name: string; value: string };
  postgresPassword: string;
  providerApiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readSecretFixture(input: unknown): SecretFixture {
  const fixture =
    isRecord(input) && isRecord(input.fixture) ? input.fixture : {};
  const headerAuth = isRecord(fixture.mcpHeaderAuth)
    ? fixture.mcpHeaderAuth
    : {};
  return {
    mcpBearerToken: readString(fixture.mcpBearerToken, "missing-mcp-bearer"),
    mcpHeaderAuth: {
      name: readString(headerAuth.name, "x-missing"),
      value: readString(headerAuth.value, "missing-mcp-header"),
    },
    postgresPassword: readString(fixture.postgresPassword, "missing-pg"),
    providerApiKey: readString(fixture.providerApiKey, "missing-provider"),
  };
}

function createTelemetryCapture(): {
  events: TelemetryEvent[];
  sink: TuvrenTelemetrySink;
  spans: TelemetrySpan[];
} {
  const events: TelemetryEvent[] = [];
  const spans: TelemetrySpan[] = [];
  return {
    events,
    sink: {
      event: (event) => {
        events.push(event);
      },
      span: (span) => {
        spans.push(span);
      },
    },
    spans,
  };
}

async function readPersistedRecords(
  harness: ConformanceKernelHarness,
  branchId: string
): Promise<Record<string, unknown>> {
  return {
    manifest: await harness.readBranchManifest(branchId),
    messages: await harness.readBranchMessages(branchId),
    runs: await harness.readBranchRuns(branchId),
    runtimeStatus: await harness.readBranchRuntimeStatus(branchId),
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.secret-isolation.surfaces
//
// Drives a turn (clean canonical stream + persisted records) and records a
// transcript whose Postgres backend options carry a connectionString and
// password. The repl-host write seam redacts them, so none of the configured
// secrets reach the persisted records, stream events, or transcript.
// ---------------------------------------------------------------------------

export async function runSecretIsolationRuntimeApi(
  input: unknown
): Promise<AdapterProjection> {
  const fixture = readSecretFixture(input);
  const harness = createConformanceKernelHarness();
  const runner = createStaticRunner(async () => {
    await Promise.resolve();
    return {
      messages: [assistantText("secret-isolation runtime-api turn")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  const streamEvents = await collectValues(handle.events());
  await handle.awaitResult();
  const persistedRecords = await readPersistedRecords(harness, thread.branchId);

  // Record a transcript whose backend options embed the secret; the redacting
  // write seam (KRT-BD002) masks it before it is ever serialized.
  const header: ReplTranscriptHeader = {
    config: {
      backend: {
        kind: "postgres",
        options: {
          connectionString: `postgres://app:${fixture.postgresPassword}@db.internal:5432/appdb`,
          database: "appdb",
          password: fixture.postgresPassword,
          schemaName: "public",
        },
      },
      providerMode: "aimock-openai",
    },
    recordedAtMs: 1,
    recordKind: "header",
    runtimeVersion: "conformance",
    v: 1,
  };
  const transcriptLines: string[] = [];
  const writer = await createReplTranscriptWriter({
    header,
    write(line) {
      transcriptLines.push(line);
    },
  });
  await writer.close();
  const transcript = transcriptLines
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

  return {
    result: {
      persistedRecords,
      streamEvents,
      transcript,
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.secret-isolation.telemetry
//
// A runner fails with an error whose raw text embeds a credential-bearing
// connection string. The telemetry error-summary sanitizer (KRT-BD001) strips
// it, so the captured telemetry attributes and error summaries are secret-free.
// ---------------------------------------------------------------------------

export async function runSecretIsolationTelemetry(
  input: unknown
): Promise<AdapterProjection> {
  const fixture = readSecretFixture(input);
  const capture = createTelemetryCapture();
  const harness = createConformanceKernelHarness();
  const runner = createStaticRunner(() => {
    // Raw provider/backend error text carrying a credential — must be sanitized
    // before it reaches any TelemetrySpan error summary.
    throw new Error(
      `backend connect failed: postgres://app:${fixture.postgresPassword}@db.internal:5432/appdb (authorization: Bearer ${fixture.mcpBearerToken})`
    );
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
    telemetry: capture.sink,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  await collectValues(handle.events());
  await handle.awaitResult();

  return {
    result: {
      telemetry: {
        events: capture.events,
        spans: capture.spans,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.secret-isolation.provider-bridge
//
// Exercises the AI SDK provider bridge (createAiSdkProviderBridge) directly at
// the TuvrenProvider generate/stream level -- NOT through a full kernel/
// runtime turn, which is deliberately out of scope for this probe (KRT-BK004).
// A fake LanguageModelV3 embeds the fixture's pattern-shaped
// `bridgeRequestToken` in two representative places: a credential-shaped
// requestBody value (Scenario: request-body secrets are screened) and a
// signed-URL-shaped response header (Scenario: response headers carrying
// signed URLs or tokens are screened). Both the `.generate()` result's
// `providerMetadata.aiSdkBridge` and the `.stream()` result's terminal
// "finish" chunk `providerMetadata.aiSdkBridge` are returned as RAW
// observation -- this adapter performs no scanning or grading; the plan's
// secretAbsence/secretPatternAbsence assertions own the verdict.
// ---------------------------------------------------------------------------

interface ProviderBridgeSecretIsolationFixture {
  bridgeRequestToken: string;
}

function readProviderBridgeSecretFixture(
  input: unknown
): ProviderBridgeSecretIsolationFixture {
  const fixture =
    isRecord(input) && isRecord(input.fixture) ? input.fixture : {};
  return {
    bridgeRequestToken: readString(
      fixture.bridgeRequestToken,
      "missing-bridge-request-token"
    ),
  };
}

function createSecretIsolationBridgeUsage() {
  return {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
    raw: { provider: "secret-isolation-probe-provider" },
  };
}

// This factory intentionally has no explicit `LanguageModelV3` return-type
// annotation: `@ai-sdk/provider` is not resolvable as a bare specifier from
// this package (it has no package.json / declared dependency, unlike
// `@tuvren/provider-bridge-ai-sdk`, which already depends on it). The
// returned shape is instead assignability-checked structurally at the
// `createAiSdkProviderBridge({ model: ... })` call site below, where TS
// resolves `LanguageModelV3` through the bridge package's own (already
// resolvable) import. The handful of `as const` markers below preserve the
// literal types (`"text"`, `"stop"`, `"v3"`, ...) that assignability needs.
function createSecretIsolationProviderBridgeModel(token: string) {
  // A credential-shaped requestBody value that is NOT equal to any of the
  // fixture's other (already covered) exact secrets.
  const requestBody = JSON.stringify({
    authorization: `Bearer ${token}`,
    model: "secret-isolation-probe-model",
  });
  // A signed-URL-shaped response header embedding the same pattern-shaped
  // token.
  const responseHeaders: Record<string, string> = {
    "x-signed-url": `https://cdn.tuvren.test/assets/probe?token=${token}`,
  };

  return {
    async doGenerate() {
      await Promise.resolve();
      return {
        content: [
          {
            text: "secret-isolation provider-bridge generate turn",
            type: "text" as const,
          },
        ],
        finishReason: { raw: "stop", unified: "stop" as const },
        request: { body: requestBody },
        response: { headers: responseHeaders },
        usage: createSecretIsolationBridgeUsage(),
        warnings: [],
      };
    },
    async doStream() {
      await Promise.resolve();
      return {
        request: { body: requestBody },
        response: { headers: responseHeaders },
        // No explicit `ReadableStream<LanguageModelV3StreamPart>` generic
        // (same reasoning as the factory's own return type): this infers as
        // `ReadableStream<any>`, which is bivariantly assignable to the
        // bridge's expected stream part type.
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ id: "text-1", type: "text-start" });
            controller.enqueue({
              delta: "secret-isolation provider-bridge stream turn",
              id: "text-1",
              type: "text-delta",
            });
            controller.enqueue({ id: "text-1", type: "text-end" });
            controller.enqueue({
              finishReason: { raw: "stop", unified: "stop" as const },
              type: "finish",
              usage: createSecretIsolationBridgeUsage(),
            });
            controller.close();
          },
        }),
      };
    },
    modelId: "secret-isolation-probe-model",
    provider: "secret-isolation-probe-provider",
    specificationVersion: "v3" as const,
    supportedUrls: {},
  };
}

function readFinishChunkAiSdkBridge(chunks: readonly unknown[]): unknown {
  const finishChunk = chunks.find(
    (chunk): chunk is Record<string, unknown> =>
      isRecord(chunk) && chunk.type === "finish"
  );
  const providerMetadata = isRecord(finishChunk)
    ? finishChunk.providerMetadata
    : undefined;
  return isRecord(providerMetadata) ? providerMetadata.aiSdkBridge : undefined;
}

export async function runSecretIsolationProviderBridge(
  input: unknown
): Promise<AdapterProjection> {
  const fixture = readProviderBridgeSecretFixture(input);
  const prompt: TuvrenPrompt = {
    messages: [
      {
        parts: [
          {
            text: "secret-isolation provider-bridge probe",
            type: "text",
          },
        ],
        role: "user",
      },
    ],
  };

  const generateBridge = createAiSdkProviderBridge({
    model: createSecretIsolationProviderBridgeModel(fixture.bridgeRequestToken),
  });
  const generateResult = await generateBridge.generate(prompt);
  const generateAiSdkBridge = isRecord(generateResult.providerMetadata)
    ? generateResult.providerMetadata.aiSdkBridge
    : undefined;

  const streamBridge = createAiSdkProviderBridge({
    model: createSecretIsolationProviderBridgeModel(fixture.bridgeRequestToken),
  });
  const streamChunks = await collectValues(streamBridge.stream(prompt));
  const streamAiSdkBridge = readFinishChunkAiSdkBridge(streamChunks);

  return {
    result: {
      generate: {
        ...(generateAiSdkBridge === undefined
          ? {}
          : { aiSdkBridge: generateAiSdkBridge }),
      },
      stream: {
        ...(streamAiSdkBridge === undefined
          ? {}
          : { aiSdkBridge: streamAiSdkBridge }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.scope-isolation.surfaces
//
// Constructs two runtimes bound to distinct Scopes (ADR-048, KRT-BE008), drives
// a turn under each, and records a transcript per Scope. Returns the RAW
// telemetry and transcript surfaces for both Scopes plus the distinct Scope
// identifiers observed on each surface. The plan owns the verdict: each Scope's
// surfaces must carry only that Scope and none of the other Scope's identifier.
// Nothing here grades; the cross-Scope comparison lives entirely in the plan's
// resultField and secretAbsence assertions.
// ---------------------------------------------------------------------------

interface ScopeSurfaceObservation {
  observedTelemetryScopes: string[];
  observedTranscriptScope: string | undefined;
  telemetry: { events: TelemetryEvent[]; spans: TelemetrySpan[] };
  transcript: unknown[];
}

function readScopePair(input: unknown): { scopeA: string; scopeB: string } {
  // Defaults diverge within the secret-absence partial-token prefix window so a
  // legitimately different Scope never trips the scanner's prefix heuristic.
  // The runner wraps the plan's `input` in a `{ checkInput }` envelope, so honor
  // the plan's declared Scopes by reading through `checkInput` rather than the
  // top level — otherwise the handler silently ignores the plan and the
  // resultField/secretAbsence assertions only agree with the defaults by chance.
  const envelope = isRecord(input) ? input : {};
  const record = isRecord(envelope.checkInput) ? envelope.checkInput : {};
  return {
    scopeA: readString(record.scopeA, "tuvren.scope.alpha"),
    scopeB: readString(record.scopeB, "tuvren.scope.bravo"),
  };
}

function distinctTelemetryScopes(
  events: readonly TelemetryEvent[],
  spans: readonly TelemetrySpan[]
): string[] {
  const scopes = new Set<string>();
  for (const event of events) {
    scopes.add(event.lineage.scope);
  }
  for (const span of spans) {
    scopes.add(span.lineage.scope);
  }
  return [...scopes].sort();
}

function readTranscriptScope(
  transcript: readonly unknown[]
): string | undefined {
  for (const record of transcript) {
    if (
      isRecord(record) &&
      record.recordKind === "header" &&
      isRecord(record.config) &&
      typeof record.config.scope === "string"
    ) {
      return record.config.scope;
    }
  }
  return undefined;
}

async function captureScopeSurfaces(
  scope: string
): Promise<ScopeSurfaceObservation> {
  const capture = createTelemetryCapture();
  const harness = createConformanceKernelHarness();
  const runner = createStaticRunner(async () => {
    await Promise.resolve();
    return {
      messages: [assistantText("scope-isolation surfaces turn")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
    scope,
    telemetry: capture.sink,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: { name: AGENT_NAME },
    signal: textSignal("run"),
    threadId: thread.threadId,
  });
  await collectValues(handle.events());
  await handle.awaitResult();

  // Record a transcript whose header is correlated to the bound Scope. The
  // input/output entries widen the scanned surface so a cross-Scope leak into
  // any persisted transcript record — not just the header — would be caught.
  const header: ReplTranscriptHeader = {
    config: {
      backend: { kind: "memory" },
      providerMode: "aimock-openai",
      scope,
    },
    recordedAtMs: 1,
    recordKind: "header",
    runtimeVersion: "conformance",
    v: 1,
  };
  const transcriptLines: string[] = [];
  const writer = await createReplTranscriptWriter({
    header,
    write(line) {
      transcriptLines.push(line);
    },
  });
  await writer.writeEntry({
    input: "run",
    ordinal: 0,
    recordKind: "input",
    recordedAtMs: 2,
    v: 1,
  });
  await writer.writeEntry({
    ordinal: 0,
    output: "scope-isolation surfaces turn",
    recordKind: "output",
    recordedAtMs: 3,
    v: 1,
  });
  await writer.close();
  const transcript = transcriptLines
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

  return {
    observedTelemetryScopes: distinctTelemetryScopes(
      capture.events,
      capture.spans
    ),
    observedTranscriptScope: readTranscriptScope(transcript),
    telemetry: { events: capture.events, spans: capture.spans },
    transcript,
  };
}

export async function runScopeIsolationSurfaces(
  input: unknown
): Promise<AdapterProjection> {
  const { scopeA, scopeB } = readScopePair(input);
  const [scopeASurfaces, scopeBSurfaces] = await Promise.all([
    captureScopeSurfaces(scopeA),
    captureScopeSurfaces(scopeB),
  ]);

  return {
    result: {
      scopeA: scopeASurfaces,
      scopeB: scopeBSurfaces,
    },
  };
}

// ---------------------------------------------------------------------------
// Operation: runtime.sanitize-seam.tool-result
//
// ADR-064 §4, following ADR-044 §4's precedent ("absence of secret material
// is asserted by conformance ... never by trusting that the hook was
// called"): a tuvren-client capability reports an error result whose content
// embeds the fixture's `sanitizeSeamMarker`. `AgentConfig.sanitizeToolResult`
// scrubs it. `stageAndEmitResult` (typescript/runtime/src/lib/
// tool-execution-helpers.ts) is the single chokepoint that applies the hook
// before BOTH durable staging and the canonical `tool.result` event, so this
// operation returns the RAW persisted tool_result part (read back from
// kernel state after the turn completes) and the RAW captured `tool.result`
// event — never the hook's return value directly. The plan's secretAbsence
// assertions (scanning both surfaces for the marker) and resultField
// assertions (requiring the scrubbed replacement text) own the verdict; this
// adapter performs no scanning or grading.
// ---------------------------------------------------------------------------

const SANITIZE_SEAM_CAP = "sanitize-seam.client.marker-bearing";
const SANITIZE_SEAM_CALL_ID = "sanitize-seam-call-1";
const SANITIZE_SEAM_SCRUBBED_MARKER = "[scrubbed-by-host-policy]";

function readSanitizeSeamMarker(input: unknown): string {
  const fixture =
    isRecord(input) && isRecord(input.fixture) ? input.fixture : {};
  return readString(fixture.sanitizeSeamMarker, "missing-sanitize-seam-marker");
}

function findToolResultPart(
  messages: readonly unknown[],
  callId: string
): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") {
      continue;
    }
    const parts = message.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (
        isRecord(part) &&
        part.type === "tool_result" &&
        part.callId === callId
      ) {
        return part;
      }
    }
  }
  return undefined;
}

export async function runSanitizeSeamToolResult(
  input: unknown
): Promise<AdapterProjection> {
  const marker = readSanitizeSeamMarker(input);
  const harness = createConformanceKernelHarness();
  const runner = createStaticRunner(async (context) => {
    await Promise.resolve();
    if (!context.messages.some((message) => message.role === "tool")) {
      return {
        messages: [
          assistantToolCalls([
            {
              callId: SANITIZE_SEAM_CALL_ID,
              input: {},
              name: SANITIZE_SEAM_CAP,
            },
          ]),
        ],
        resolution: { type: "continue_iteration" as const },
        toolExecutionMode: "parallel" as const,
      };
    }
    return {
      messages: [assistantText("sanitize-seam conformance turn")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
  const endpoint: AttachedClientEndpoint = {
    advertisedCapabilities: [
      {
        capabilityId: SANITIZE_SEAM_CAP,
        description: "sanitize-seam conformance capability",
        inputSchema: { type: "object" },
      },
    ],
    dispatch(
      envelope: ClientInvocationEnvelope
    ): Promise<ClientReportedResult> {
      return Promise.resolve({
        callId: envelope.callId,
        content: {
          message: `boom: leaked secret ${marker} in a client-reported error message`,
        },
        isError: true,
        leaseToken: envelope.leaseToken,
      });
    },
    endpointId: "ep-sanitize-seam",
  };
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultRunnerId: RUNNER_ID,
    runnerRegistry: createRunnerRegistry([runner]),
    kernel: harness.kernel,
  });
  const thread = await runtime.createThread({});
  const handle = runtime.executeTurn({
    branchId: thread.branchId,
    config: {
      clientEndpoints: [endpoint],
      name: AGENT_NAME,
      sanitizeToolResult(result) {
        const output = isRecord(result.output) ? result.output : {};
        const message =
          typeof output.message === "string" ? output.message : "";
        return {
          ...result,
          output: {
            message: message.split(marker).join(SANITIZE_SEAM_SCRUBBED_MARKER),
          },
        };
      },
    },
    signal: textSignal("sanitize-seam conformance"),
    threadId: thread.threadId,
  });
  const streamEvents = await collectValues(handle.events());
  await handle.awaitResult();

  const persistedMessages = await harness.readBranchMessages(thread.branchId);
  const persistedToolMessagePart =
    findToolResultPart(persistedMessages, SANITIZE_SEAM_CALL_ID) ?? null;
  const emittedToolResultEvent =
    streamEvents.find(
      (event) => isRecord(event) && event.type === "tool.result"
    ) ?? null;

  return {
    result: {
      sanitizeSeam: {
        emittedToolResultEvent,
        persistedToolMessagePart,
      },
    },
  };
}
