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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelRecord } from "@tuvren/core-types";
import {
  encodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type StagedResult,
  type TurnTreeSchema,
} from "@tuvren/kernel-protocol";
import { formatGeneratedJson } from "./format-generated-json.ts";

interface TurnNodeSpec {
  consumedStagedResults: StagedResult[];
  eventHash: string | null;
  previousTurnNodeHash: string | null;
  schemaId: string;
  turnTreeHash: string;
}

interface FixtureSpec {
  fileName: string;
  rawOpaqueBytes: number[];
  schema: TurnTreeSchema;
  turnNode: TurnNodeSpec;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES_DIR = resolve(
  REPO_ROOT,
  "boundaries/kernel/conformance/fixtures"
);

const HASH_ZERO = "0".repeat(64);
const HASH_ONE = "1".repeat(64);
const HASH_TWO = "2".repeat(64);
const HASH_THREE = "3".repeat(64);
const HASH_FOUR = "4".repeat(64);
const HASH_FIVE = "5".repeat(64);
const HASH_SIX = "6".repeat(64);

const fixtures: FixtureSpec[] = [
  {
    fileName: "kernel-protocol-empty-bytes.json",
    rawOpaqueBytes: [],
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-single-byte.json",
    rawOpaqueBytes: [42],
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [
        {
          objectHash: HASH_THREE,
          objectType: "message",
          status: "completed",
          taskId: "task_only",
          timestamp: 1_700_000_000_000,
        },
      ],
      eventHash: HASH_FOUR,
      previousTurnNodeHash: HASH_FIVE,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-all-zero-bytes.json",
    rawOpaqueBytes: Array.from({ length: 64 }, () => 0),
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-all-ones-bytes.json",
    rawOpaqueBytes: Array.from({ length: 64 }, () => 0xff),
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-large-bytes.json",
    rawOpaqueBytes: Array.from({ length: 256 }, (_, index) => index % 256),
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-multi-path-schema.json",
    rawOpaqueBytes: [10, 20, 30, 40, 50],
    schema: {
      incorporationRules: [
        { objectType: "message", targetPath: "messages" },
        { objectType: "tool_call", targetPath: "tools.calls" },
        { objectType: "tool_result", targetPath: "tools.results" },
        { objectType: "context_manifest", targetPath: "context.manifest" },
        { objectType: "approval", targetPath: "approval.last" },
      ],
      paths: [
        { collection: "ordered", path: "messages" },
        { collection: "ordered", path: "tools.calls" },
        { collection: "ordered", path: "tools.results" },
        { collection: "single", path: "context.manifest" },
        { collection: "single", path: "approval.last" },
      ],
      schemaId: "schema_multi_path",
    },
    turnNode: {
      consumedStagedResults: [
        {
          objectHash: HASH_THREE,
          objectType: "message",
          status: "completed",
          taskId: "msg_1",
          timestamp: 1_700_000_000_000,
        },
        {
          objectHash: HASH_FOUR,
          objectType: "tool_call",
          status: "completed",
          taskId: "tool_call_1",
          timestamp: 1_700_000_000_001,
        },
        {
          objectHash: HASH_FIVE,
          objectType: "tool_result",
          status: "completed",
          taskId: "tool_result_1",
          timestamp: 1_700_000_000_002,
        },
      ],
      eventHash: HASH_SIX,
      previousTurnNodeHash: HASH_ONE,
      schemaId: "schema_multi_path",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-all-single-paths-schema.json",
    rawOpaqueBytes: [99],
    schema: {
      incorporationRules: [
        { objectType: "context_manifest", targetPath: "context.manifest" },
        { objectType: "approval", targetPath: "approval" },
      ],
      paths: [
        { collection: "single", path: "context.manifest" },
        { collection: "single", path: "approval" },
      ],
      schemaId: "schema_singletons",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_singletons",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-all-ordered-paths-schema.json",
    rawOpaqueBytes: [1, 2, 3],
    schema: {
      incorporationRules: [
        { objectType: "message", targetPath: "messages" },
        { objectType: "tool_call", targetPath: "tool_calls" },
      ],
      paths: [
        { collection: "ordered", path: "messages" },
        { collection: "ordered", path: "tool_calls" },
      ],
      schemaId: "schema_all_ordered",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_all_ordered",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-with-prev-turn.json",
    rawOpaqueBytes: [7, 7, 7],
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: HASH_FIVE,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-with-event-hash.json",
    rawOpaqueBytes: [8, 8, 8],
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: HASH_FOUR,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-staged-result-failed.json",
    rawOpaqueBytes: [9],
    schema: {
      incorporationRules: [
        { objectType: "tool_result", targetPath: "tools.results" },
      ],
      paths: [{ collection: "ordered", path: "tools.results" }],
      schemaId: "schema_tool_results",
    },
    turnNode: {
      consumedStagedResults: [
        {
          objectHash: HASH_THREE,
          objectType: "tool_result",
          status: "failed",
          taskId: "tool_call_failed",
          timestamp: 1_700_000_000_010,
        },
      ],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_tool_results",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-staged-result-interrupted.json",
    rawOpaqueBytes: [10],
    schema: {
      incorporationRules: [
        { objectType: "tool_result", targetPath: "tools.results" },
      ],
      paths: [{ collection: "ordered", path: "tools.results" }],
      schemaId: "schema_tool_results",
    },
    turnNode: {
      consumedStagedResults: [
        {
          interruptPayload: { reason: "tool_paused", remainingMs: 5000 },
          objectHash: HASH_THREE,
          objectType: "tool_result",
          status: "interrupted",
          taskId: "tool_call_interrupted",
          timestamp: 1_700_000_000_020,
        },
      ],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_tool_results",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-many-staged-results.json",
    rawOpaqueBytes: [11, 12, 13, 14],
    schema: {
      incorporationRules: [
        { objectType: "tool_result", targetPath: "tools.results" },
      ],
      paths: [{ collection: "ordered", path: "tools.results" }],
      schemaId: "schema_tool_results",
    },
    turnNode: {
      consumedStagedResults: Array.from({ length: 5 }, (_, index) => ({
        objectHash: indexedHash(index + 1),
        objectType: "tool_result",
        status: "completed" as const,
        taskId: `tool_call_${index + 1}`,
        timestamp: 1_700_000_000_000 + index,
      })),
      eventHash: HASH_SIX,
      previousTurnNodeHash: HASH_ONE,
      schemaId: "schema_tool_results",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-deep-path-schema.json",
    rawOpaqueBytes: [15],
    schema: {
      incorporationRules: [
        { objectType: "deep", targetPath: "a.b.c.d.deep_value" },
      ],
      paths: [{ collection: "single", path: "a.b.c.d.deep_value" }],
      schemaId: "schema_deep_path",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_deep_path",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-non-utf8-bytes.json",
    rawOpaqueBytes: [0xc3, 0x28, 0xa0, 0xa1, 0xff, 0xfe, 0xfd],
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_TWO,
    },
  },
  {
    fileName: "kernel-protocol-zero-turn-tree-hash.json",
    rawOpaqueBytes: [16],
    schema: {
      incorporationRules: [{ objectType: "message", targetPath: "messages" }],
      paths: [{ collection: "ordered", path: "messages" }],
      schemaId: "schema_minimal",
    },
    turnNode: {
      consumedStagedResults: [],
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: "schema_minimal",
      turnTreeHash: HASH_ZERO,
    },
  },
  {
    fileName: "kernel-protocol-mixed-status-staged-results.json",
    rawOpaqueBytes: [17, 18],
    schema: {
      incorporationRules: [
        { objectType: "message", targetPath: "messages" },
        { objectType: "tool_result", targetPath: "tools.results" },
      ],
      paths: [
        { collection: "ordered", path: "messages" },
        { collection: "ordered", path: "tools.results" },
      ],
      schemaId: "schema_mixed",
    },
    turnNode: {
      consumedStagedResults: [
        {
          objectHash: indexedHash(1),
          objectType: "message",
          status: "completed",
          taskId: "msg_1",
          timestamp: 1_700_000_000_000,
        },
        {
          objectHash: indexedHash(2),
          objectType: "tool_result",
          status: "failed",
          taskId: "tool_failed_1",
          timestamp: 1_700_000_000_001,
        },
        {
          interruptPayload: { reason: "user_interrupt" },
          objectHash: indexedHash(3),
          objectType: "tool_result",
          status: "interrupted",
          taskId: "tool_int_1",
          timestamp: 1_700_000_000_002,
        },
      ],
      eventHash: null,
      previousTurnNodeHash: HASH_ONE,
      schemaId: "schema_mixed",
      turnTreeHash: HASH_TWO,
    },
  },
];

await main();

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const filePaths: string[] = [];

  for (const fixture of fixtures) {
    const fixtureRecord = await buildFixtureRecord(fixture);
    const filePath = resolve(FIXTURES_DIR, fixture.fileName);
    await writeFile(filePath, `${JSON.stringify(fixtureRecord, null, 2)}\n`);
    filePaths.push(filePath);
    process.stdout.write(`wrote ${fixture.fileName}\n`);
  }

  await formatGeneratedJson(filePaths);
}

async function buildFixtureRecord(
  spec: FixtureSpec
): Promise<Record<string, unknown>> {
  const opaqueBytes = Uint8Array.from(spec.rawOpaqueBytes);
  const rawOpaqueBytesSha256Hex = await hashOpaqueObjectBytes(opaqueBytes);

  const schemaRecord = spec.schema as unknown as KernelRecord;
  const schemaCbor = encodeDeterministicKernelRecord(schemaRecord);
  const schemaSha = await hashKernelRecord(schemaRecord);

  const turnNodeRecord = projectTurnNodeRecord(spec.turnNode);
  const turnNodeCbor = encodeDeterministicKernelRecord(turnNodeRecord);
  const turnNodeSha = await hashTurnNodeIdentity(spec.turnNode);

  return {
    rawOpaqueBytes: spec.rawOpaqueBytes,
    rawOpaqueBytesSha256Hex,
    turnNodeIdentityRecord: spec.turnNode,
    turnNodeIdentityRecordCborHex: bytesToHex(turnNodeCbor),
    turnNodeIdentityRecordSha256Hex: turnNodeSha,
    turnTreeSchemaRecord: spec.schema,
    turnTreeSchemaRecordCborHex: bytesToHex(schemaCbor),
    turnTreeSchemaRecordSha256Hex: schemaSha,
  };
}

function projectTurnNodeRecord(turnNode: TurnNodeSpec): KernelRecord {
  return {
    consumedStagedResults: turnNode.consumedStagedResults.map((result) => {
      const projection: Record<string, unknown> = {
        objectHash: result.objectHash,
        objectType: result.objectType,
        status: result.status,
        taskId: result.taskId,
        timestamp: result.timestamp,
      };

      if (result.interruptPayload !== undefined) {
        projection.interruptPayload = result.interruptPayload;
      }

      return projection as KernelRecord;
    }),
    eventHash: turnNode.eventHash,
    previousTurnNodeHash: turnNode.previousTurnNodeHash,
    schemaId: turnNode.schemaId,
    turnTreeHash: turnNode.turnTreeHash,
  };
}

function indexedHash(index: number): string {
  const stringIndex = index.toString(16).padStart(2, "0");
  return stringIndex.repeat(32);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
