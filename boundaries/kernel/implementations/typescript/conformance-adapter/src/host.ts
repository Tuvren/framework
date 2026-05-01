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

import {
  assertStagedResult,
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
  type StagedResult,
} from "@tuvren/kernel-protocol";
import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../../../tools/conformance/adapter-protocol/index.js";
import { serveStdioAdapter } from "../../../../../../tools/conformance/adapter-protocol/stdio-host.js";

interface AdapterInput {
  fixture?: unknown;
}

class TypeScriptKernelAdapter {
  initialize(
    packetId: string,
    planVersion: string
  ): Promise<AdapterCapabilities> {
    return Promise.resolve({
      adapterId: "typescript-kernel",
      capabilities: ["kernel.protocol"],
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
