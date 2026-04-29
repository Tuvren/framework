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
import {
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
} from "@tuvren/kernel-protocol";
import {
  canonicalKernelTestSchemaFixture,
  kernelProtocolDeterministicFixtures,
  kernelProtocolLogicalFixtures,
} from "../src/lib/kernel-conformance-fixtures.ts";

describe("@tuvren/kernel-testkit conformance assets", () => {
  test("loads the canonical boundary-owned schema fixture", () => {
    expect(canonicalKernelTestSchemaFixture.schemaId).toBe("schema_main");
    // The seeded Epic R schema is intentionally minimal: path collection and
    // incorporation routing are authoritative here, while richer metadata
    // promotion remains later artifact work.
    expect(canonicalKernelTestSchemaFixture.paths).toEqual([
      {
        collection: "ordered",
        path: "messages",
      },
      {
        collection: "single",
        path: "context.manifest",
      },
    ]);
  });

  test("keeps deterministic kernel fixture hashes and encodings aligned", async () => {
    const rawOpaqueBytes = Uint8Array.from(
      kernelProtocolDeterministicFixtures.rawOpaqueBytes
    );

    expect(await hashOpaqueObjectBytes(rawOpaqueBytes)).toBe(
      kernelProtocolDeterministicFixtures.rawOpaqueBytesSha256Hex
    );
    // Decode the checked-in deterministic CBOR fixtures instead of casting the
    // typed schema records through a looser kernel-record API. That keeps the
    // assertion path explicit without weakening the test types.
    const decodedTurnTreeSchemaRecord = decodeDeterministicKernelRecord(
      hexToBytes(
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex
      )
    );
    const decodedTurnNodeIdentityRecord = decodeDeterministicKernelRecord(
      hexToBytes(
        kernelProtocolDeterministicFixtures.turnNodeIdentityRecordCborHex
      )
    );

    expectDecodedTurnTreeSchemaRecord(
      decodedTurnTreeSchemaRecord,
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
    );
    expect(await hashKernelRecord(decodedTurnTreeSchemaRecord)).toBe(
      kernelProtocolDeterministicFixtures.turnTreeSchemaRecordSha256Hex
    );
    expectDecodedTurnNodeIdentityRecord(
      decodedTurnNodeIdentityRecord,
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
    );
    expect(
      await hashTurnNodeIdentity({
        consumedStagedResults: [
          ...kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
            .consumedStagedResults,
        ],
        eventHash:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord.eventHash,
        previousTurnNodeHash:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
            .previousTurnNodeHash,
        schemaId:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord.schemaId,
        turnTreeHash:
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
            .turnTreeHash,
      })
    ).toBe(kernelProtocolDeterministicFixtures.turnNodeIdentityRecordSha256Hex);
  });

  test("loads logical recovery and lineage change fixtures", () => {
    expect(kernelProtocolLogicalFixtures.branchHeadListEntry).toEqual([
      "branch_main",
      "9999999999999999999999999999999999999999999999999999999999999999",
    ]);
    expect(kernelProtocolLogicalFixtures.recoveryState).toMatchObject({
      lastCompletedStepId: "tool_execution",
      lastTurnNodeHash:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      stepSequence: [
        {
          deterministic: false,
          id: "model_call",
          metadata: {
            phase: "reasoning",
          },
          sideEffects: false,
        },
        {
          deterministic: false,
          id: "tool_execution",
          metadata: {
            phase: "tooling",
          },
          sideEffects: true,
        },
      ],
    });
    expect(
      kernelProtocolLogicalFixtures.recoveryState.consumedStagedResults
    ).toHaveLength(1);
    expect(
      kernelProtocolLogicalFixtures.recoveryState.uncommittedStagedResults
    ).toHaveLength(1);
    expect(kernelProtocolLogicalFixtures.turnTreeChangeSet).toEqual({
      "context.manifest":
        "1111111111111111111111111111111111111111111111111111111111111111",
      messages: [
        "2222222222222222222222222222222222222222222222222222222222222222",
        "2323232323232323232323232323232323232323232323232323232323232323",
      ],
    });
  });
});

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{1,2}/gu)?.map((entry) => Number.parseInt(entry, 16)) ?? []
  );
}

function expectDecodedTurnTreeSchemaRecord(
  value: unknown,
  expected: typeof kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
): void {
  expect(isPlainRecord(value)).toBe(true);

  if (!(isPlainRecord(value) && Array.isArray(value.paths))) {
    throw new Error("decoded turn tree schema record must contain paths");
  }

  expect(value.schemaId).toBe(expected.schemaId);
  expect(value.paths).toEqual(expected.paths);
  expect(value.incorporationRules).toEqual(expected.incorporationRules);
}

function expectDecodedTurnNodeIdentityRecord(
  value: unknown,
  expected: typeof kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
): void {
  expect(isPlainRecord(value)).toBe(true);

  if (!(isPlainRecord(value) && Array.isArray(value.consumedStagedResults))) {
    throw new Error(
      "decoded turn node identity record must contain consumed staged results"
    );
  }

  expect(value.schemaId).toBe(expected.schemaId);
  expect(value.eventHash).toBe(expected.eventHash);
  expect(value.previousTurnNodeHash).toBe(expected.previousTurnNodeHash);
  expect(value.turnTreeHash).toBe(expected.turnTreeHash);
  expect(value.consumedStagedResults).toEqual(expected.consumedStagedResults);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
