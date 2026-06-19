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
  TelemetryEvent,
  TelemetrySpan,
  TuvrenTelemetrySink,
} from "@tuvren/core/telemetry";
import {
  createReplTranscriptWriter,
  type ReplTranscriptHeader,
} from "@tuvren/repl-host";
import {
  createDriverRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
} from "@tuvren/runtime";
import type {
  AdapterProjection,
  ConformanceKernelHarness,
} from "./framework-adapter-runtime.ts";
import {
  AGENT_NAME,
  assistantText,
  collectValues,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticDriver,
  DRIVER_ID,
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
  const driver = createStaticDriver(async () => {
    await Promise.resolve();
    return {
      messages: [assistantText("secret-isolation runtime-api turn")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
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
// A driver fails with an error whose raw text embeds a credential-bearing
// connection string. The telemetry error-summary sanitizer (KRT-BD001) strips
// it, so the captured telemetry attributes and error summaries are secret-free.
// ---------------------------------------------------------------------------

export async function runSecretIsolationTelemetry(
  input: unknown
): Promise<AdapterProjection> {
  const fixture = readSecretFixture(input);
  const capture = createTelemetryCapture();
  const harness = createConformanceKernelHarness();
  const driver = createStaticDriver(() => {
    // Raw provider/backend error text carrying a credential — must be sanitized
    // before it reaches any TelemetrySpan error summary.
    throw new Error(
      `backend connect failed: postgres://app:${fixture.postgresPassword}@db.internal:5432/appdb (authorization: Bearer ${fixture.mcpBearerToken})`
    );
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
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
  const driver = createStaticDriver(async () => {
    await Promise.resolve();
    return {
      messages: [assistantText("scope-isolation surfaces turn")],
      resolution: { reason: "done", type: "end_turn" as const },
    };
  });
  const runtime = createTuvrenRuntimeCore({
    createId: createConformanceIdFactory(),
    defaultDriverId: DRIVER_ID,
    driverRegistry: createDriverRegistry([driver]),
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
