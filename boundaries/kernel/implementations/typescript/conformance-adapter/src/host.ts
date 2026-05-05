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

import { createMemoryBackend } from "@tuvren/backend-memory";
import {
  assertRecoveryState,
  assertStagedResult,
  assertTurnTreeChangeSet,
  assertTurnTreeSchema,
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type RecoveryState,
  type StagedResult,
  type TurnTreeChangeSet,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { createRuntimeKernel } from "@tuvren/kernel-runtime";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";

declare const Bun: {
  file(path: string | URL): {
    json(): Promise<unknown>;
  };
};

const CANONICAL_SCHEMA_URL = new URL(
  "../../../../conformance/fixtures/canonical-turn-tree-schema.json",
  import.meta.url
);

interface AdapterInput {
  fixture?: unknown;
}

interface LogicalFixture {
  branchHeadListEntry: [string, string];
  recoveryState: RecoveryState;
  turnTreeChangeSet: TurnTreeChangeSet;
}

let canonicalSchemaPromise: Promise<TurnTreeSchema> | undefined;

class TypeScriptKernelAdapter {
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    return Promise.resolve({
      adapterId: "typescript-kernel",
      capabilities: ["kernel.protocol", "kernel.logical"],
      packetId,
      planVersion,
    });
  }

  async dispatch(
    operation: string,
    input: unknown,
    _controls: AdapterControls
  ): Promise<OperationOutcome> {
    try {
      switch (operation) {
        case "kernel.protocol.deterministic-hashing":
          return result(await deterministicHashing(readFixture(input)));
        case "kernel.protocol.schema-roundtrip":
          return result(schemaRoundtrip(readFixture(input)));
        case "kernel.logical.diff-paths":
          return result(await runLogicalDiff(readFixture(input)));
        case "kernel.logical.branch-list":
          return result(await runBranchList(readFixture(input)));
        case "kernel.logical.recovery-state":
          return result(await runRecoveryState(readFixture(input)));
        case "kernel.lineage.cross-thread-rejection":
          return result(await runCrossThreadLineage());
        default:
          return {
            error: {
              code: "adapter_operation_not_implemented",
              message: `TypeScript kernel adapter does not implement ${operation}`,
            },
            kind: "error",
          };
      }
    } catch (error: unknown) {
      return {
        error: createAdapterErrorEnvelope(error),
        kind: "error",
      };
    }
  }
}

await serveStdioAdapter(new TypeScriptKernelAdapter());

async function deterministicHashing(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rawOpaqueBytes = readNumberArray(
    fixture.rawOpaqueBytes,
    "rawOpaqueBytes"
  );
  const schemaRecord = decodeDeterministicKernelRecord(
    hexToBytes(readString(fixture.turnTreeSchemaRecordCborHex, "schema cbor"))
  );
  const turnNodeIdentityRecord = readRecord(
    fixture.turnNodeIdentityRecord,
    "turnNodeIdentityRecord"
  );
  const turnNodeHash = await hashTurnNodeIdentity({
    consumedStagedResults: readStagedResults(
      turnNodeIdentityRecord.consumedStagedResults,
      "consumedStagedResults"
    ),
    eventHash: readNullableString(
      turnNodeIdentityRecord.eventHash,
      "eventHash"
    ),
    previousTurnNodeHash: readNullableString(
      turnNodeIdentityRecord.previousTurnNodeHash,
      "previousTurnNodeHash"
    ),
    schemaId: readString(turnNodeIdentityRecord.schemaId, "schemaId"),
    turnTreeHash: readString(
      turnNodeIdentityRecord.turnTreeHash,
      "turnTreeHash"
    ),
  });

  return {
    evidence: {
      hashes: {
        rawOpaqueBytes: await hashOpaqueObjectBytes(
          Uint8Array.from(rawOpaqueBytes)
        ),
        turnNodeIdentity: turnNodeHash,
        turnTreeSchema: await hashKernelRecord(schemaRecord),
      },
    },
  };
}

function schemaRoundtrip(
  fixture: Record<string, unknown>
): Record<string, unknown> {
  return {
    evidence: {
      roundtrip: {
        turnNodeIdentityRecord: decodeDeterministicKernelRecord(
          hexToBytes(
            readString(
              fixture.turnNodeIdentityRecordCborHex,
              "turnNodeIdentityRecordCborHex"
            )
          )
        ),
        turnTreeSchemaRecord: decodeDeterministicKernelRecord(
          hexToBytes(
            readString(
              fixture.turnTreeSchemaRecordCborHex,
              "turnTreeSchemaRecordCborHex"
            )
          )
        ),
      },
    },
  };
}

async function runLogicalDiff(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  const kernel = await createConformanceKernel(schema);
  const created = await kernel.thread.create(
    "thread_conformance",
    schema.schemaId,
    logical.branchHeadListEntry[0]
  );
  const changedTree = await kernel.tree.create(
    schema.schemaId,
    logical.turnTreeChangeSet,
    created.rootTurnTreeHash
  );
  const diffPaths = (
    await kernel.tree.diff(created.rootTurnTreeHash, changedTree)
  ).toSorted();

  return { evidence: { diffPaths } };
}

async function runBranchList(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  const kernel = await createConformanceKernel(schema);
  await kernel.thread.create(
    "thread_conformance",
    schema.schemaId,
    logical.branchHeadListEntry[0]
  );
  const branchEntries = await kernel.branch.list("thread_conformance");

  return { evidence: { branchEntries } };
}

async function runRecoveryState(
  fixture: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const logical = readLogicalFixture(fixture, schema);
  const kernel = await createConformanceKernel(schema);
  const thread = await kernel.thread.create(
    "thread_conformance",
    schema.schemaId,
    logical.branchHeadListEntry[0]
  );
  const turn = await kernel.turn.create(
    "turn_recovery",
    thread.threadId,
    thread.branchId,
    null,
    thread.rootTurnNodeHash
  );
  await kernel.run.create(
    "run_recovery",
    turn.turnId,
    thread.branchId,
    schema.schemaId,
    thread.rootTurnNodeHash,
    logical.recoveryState.stepSequence
  );

  const [firstStep, secondStep] = logical.recoveryState.stepSequence;

  if (firstStep === undefined || secondStep === undefined) {
    throw new Error("logical recovery fixture must declare at least two steps");
  }

  await kernel.run.beginStep("run_recovery", firstStep.id);
  await kernel.run.completeStep("run_recovery", firstStep.id);
  await kernel.run.beginStep("run_recovery", secondStep.id);

  for (const [
    index,
    stagedResult,
  ] of logical.recoveryState.consumedStagedResults.entries()) {
    await stageFixtureResult(kernel, "run_recovery", stagedResult, index);
  }

  await kernel.run.completeStep("run_recovery", secondStep.id);

  for (const [
    index,
    stagedResult,
  ] of logical.recoveryState.uncommittedStagedResults.entries()) {
    await stageFixtureResult(kernel, "run_recovery", stagedResult, index);
  }

  const recovery = await kernel.run.recover("run_recovery");

  return {
    evidence: {
      recovery: {
        consumedStagedResults: recovery.consumedStagedResults.length,
        lastCompletedStepId: recovery.lastCompletedStepId,
        uncommittedStagedResults: recovery.uncommittedStagedResults.length,
      },
    },
  };
}

async function runCrossThreadLineage(): Promise<Record<string, unknown>> {
  const schema = await loadCanonicalSchema();
  const kernel = await createConformanceKernel(schema);
  const threadA = await kernel.thread.create(
    "thread_a",
    schema.schemaId,
    "branch_a"
  );
  const turnA = await kernel.turn.create(
    "turn_a",
    threadA.threadId,
    threadA.branchId,
    null,
    threadA.rootTurnNodeHash
  );
  await kernel.run.create(
    "run_a",
    turnA.turnId,
    threadA.branchId,
    schema.schemaId,
    threadA.rootTurnNodeHash,
    [{ deterministic: false, id: "step_a", sideEffects: false }]
  );
  const completed = await kernel.run.completeStep("run_a", "step_a");

  if (completed.turnNodeHash === undefined) {
    throw new Error("expected checkpoint hash for cross-thread lineage check");
  }

  await kernel.thread.create("thread_b", schema.schemaId, "branch_b");

  try {
    await kernel.branch.create(
      "branch_cross_thread",
      "thread_b",
      completed.turnNodeHash
    );

    // Unexpected acceptance is surfaced as evidence instead of crashing the
    // adapter so the shared runner can report one semantic failure cleanly.
    return {
      evidence: {
        diagnostics: ["thread A node unexpectedly seeded thread B branch"],
        errorCode: "unexpected_success",
      },
    };
  } catch (error: unknown) {
    return {
      evidence: {
        errorCode: normalizeLogicalErrorCode(readErrorCode(error)),
      },
    };
  }
}

async function createConformanceKernel(schema: TurnTreeSchema) {
  const kernel = createRuntimeKernel({ backend: createMemoryBackend() });
  await kernel.schema.register(schema);
  return kernel;
}

async function loadCanonicalSchema(): Promise<TurnTreeSchema> {
  canonicalSchemaPromise ??= Bun.file(CANONICAL_SCHEMA_URL)
    .json()
    .then((value: unknown) => {
      assertTurnTreeSchema(value, "canonical kernel conformance schema");
      return value;
    });

  return await canonicalSchemaPromise;
}

async function stageFixtureResult(
  kernel: ReturnType<typeof createRuntimeKernel>,
  runId: string,
  stagedResult: StagedResult,
  index: number
): Promise<void> {
  await kernel.staging.stage(
    runId,
    new TextEncoder().encode(`fixture staged result ${index}`),
    stagedResult.taskId,
    stagedResult.objectType,
    stagedResult.status,
    stagedResult.status === "interrupted"
      ? stagedResult.interruptPayload
      : undefined
  );
}

function normalizeLogicalErrorCode(code: string): string {
  // The conformance plan stays binding-neutral, so the adapter translates
  // implementation-specific error codes into the stable shared evidence names.
  switch (code) {
    case "kernel_runtime_lineage_mismatch":
      return "turn_node_thread_mismatch";
    case "kernel_runtime_turn_head_lineage_mismatch":
      return "turn_head_lateral_move";
    default:
      return code;
  }
}

function readErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Reflect.get(error, "code");

    if (typeof code === "string") {
      return code;
    }
  }

  if (error instanceof Error) {
    return error.name;
  }

  return "unknown_error";
}

function result(value: Record<string, unknown>): OperationOutcome {
  return {
    kind: "result",
    value,
  };
}

function readFixture(input: unknown): Record<string, unknown> {
  const object = readRecord(input, "adapter input") as AdapterInput;
  return readRecord(object.fixture, "adapter input fixture");
}

function readLogicalFixture(
  fixture: Record<string, unknown>,
  schema: TurnTreeSchema
): LogicalFixture {
  const branchHeadListEntry = readArray(
    fixture.branchHeadListEntry,
    "branchHeadListEntry"
  );

  if (branchHeadListEntry.length !== 2) {
    throw new Error("branchHeadListEntry must contain exactly two items");
  }

  const branchId = readString(branchHeadListEntry[0], "branchHeadListEntry[0]");
  const branchHead = readString(
    branchHeadListEntry[1],
    "branchHeadListEntry[1]"
  );
  const recoveryState = fixture.recoveryState;
  assertRecoveryState(recoveryState, "recoveryState");
  const turnTreeChangeSet = fixture.turnTreeChangeSet;
  assertTurnTreeChangeSet(turnTreeChangeSet, schema, "turnTreeChangeSet");

  return {
    branchHeadListEntry: [branchId, branchHead],
    recoveryState,
    turnTreeChangeSet,
  };
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error("fixture hex must have even length");
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function readStagedResults(value: unknown, label: string): StagedResult[] {
  const results = readArray(value, label);
  const stagedResults: StagedResult[] = [];

  for (const [index, result] of results.entries()) {
    assertStagedResult(result, `${label}[${index}]`);
    stagedResults.push(result);
  }

  return stagedResults;
}

function readNumberArray(value: unknown, label: string): number[] {
  const values = readArray(value, label);

  if (!values.every((entry) => typeof entry === "number")) {
    throw new Error(`${label} must contain numbers`);
  }

  return values;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, label);
}
