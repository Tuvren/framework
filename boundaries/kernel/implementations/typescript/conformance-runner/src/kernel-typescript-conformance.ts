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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  decodeDeterministicKernelRecord,
  hashKernelRecord,
  hashOpaqueObjectBytes,
  hashTurnNodeIdentity,
} from "@tuvren/kernel-protocol";
import {
  type ConformanceCheckResult,
  type ConformanceEvidence,
  createAssertionResult,
  createCheckResult,
  createConformanceEvidenceSummary,
} from "../../../../../../tools/scripts/lib/conformance-contract.js";
import {
  emitConformanceEvidence,
  readConformanceSuiteManifest,
  selectImplementationChecks,
} from "../../../../../../tools/scripts/lib/conformance-runner.js";
import { kernelProtocolDeterministicFixtures } from "../../../../testkit/src/lib/kernel-conformance-fixtures.ts";

const KERNEL_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../conformance/scenarios/suite-manifest.json"
);
const IMPLEMENTATION_ID = "typescript-kernel";
const LANGUAGE = "typescript";

await main();

async function main(): Promise<void> {
  const manifest = await readConformanceSuiteManifest(KERNEL_MANIFEST_PATH);
  const checkResults: ConformanceCheckResult[] = [];

  for (const check of selectImplementationChecks(manifest, IMPLEMENTATION_ID)) {
    checkResults.push(await runCheck(check.checkId));
  }

  const summary = createConformanceEvidenceSummary(checkResults);
  const evidence: ConformanceEvidence = {
    boundary: manifest.boundary,
    checkResults,
    implementationId: IMPLEMENTATION_ID,
    language: LANGUAGE,
    status: summary.failedChecks === 0 ? "pass" : "fail",
    suiteId: manifest.suiteId,
    suiteVersion: manifest.suiteVersion,
    summary,
  };

  emitConformanceEvidence(evidence);
}

function runCheck(checkId: string): Promise<ConformanceCheckResult> {
  switch (checkId) {
    case "kernel.protocol.deterministic_hashing":
      return createDeterministicHashingCheck();
    case "kernel.protocol.schema_roundtrip":
      return Promise.resolve(createSchemaRoundtripCheck());
    default:
      throw new Error(`unsupported kernel conformance check ${checkId}`);
  }
}

async function createDeterministicHashingCheck(): Promise<ConformanceCheckResult> {
  const rawOpaqueHash = await hashOpaqueObjectBytes(
    Uint8Array.from(kernelProtocolDeterministicFixtures.rawOpaqueBytes)
  );
  const schemaHash = await hashKernelRecord(
    decodeDeterministicKernelRecord(
      hexToBytes(
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex
      )
    )
  );
  const turnNodeHash = await hashTurnNodeIdentity({
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
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecord.turnTreeHash,
  });

  return createCheckResult(
    "kernel.protocol.deterministic_hashing",
    [
      createAssertionResult(
        "raw_opaque_bytes_hash",
        rawOpaqueHash ===
          kernelProtocolDeterministicFixtures.rawOpaqueBytesSha256Hex
      ),
      createAssertionResult(
        "turn_tree_schema_hash",
        schemaHash ===
          kernelProtocolDeterministicFixtures.turnTreeSchemaRecordSha256Hex
      ),
      createAssertionResult(
        "turn_node_identity_hash",
        turnNodeHash ===
          kernelProtocolDeterministicFixtures.turnNodeIdentityRecordSha256Hex
      ),
    ],
    {
      hashKinds: ["rawOpaqueBytes", "turnTreeSchema", "turnNodeIdentity"],
    }
  );
}

function createSchemaRoundtripCheck(): ConformanceCheckResult {
  const decodedSchema = decodeDeterministicKernelRecord(
    hexToBytes(kernelProtocolDeterministicFixtures.turnTreeSchemaRecordCborHex)
  );
  const decodedTurnNode = decodeDeterministicKernelRecord(
    hexToBytes(
      kernelProtocolDeterministicFixtures.turnNodeIdentityRecordCborHex
    )
  );

  return createCheckResult("kernel.protocol.schema_roundtrip", [
    createAssertionResult(
      "turn_tree_schema_cbor_roundtrip",
      isDeepStrictEqual(
        decodedSchema,
        kernelProtocolDeterministicFixtures.turnTreeSchemaRecord
      )
    ),
    createAssertionResult(
      "turn_node_identity_cbor_roundtrip",
      isDeepStrictEqual(
        decodedTurnNode,
        kernelProtocolDeterministicFixtures.turnNodeIdentityRecord
      )
    ),
  ]);
}
function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error("fixture hex must have even length");
  }

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);

    if (!Number.isSafeInteger(byte)) {
      throw new Error("fixture hex must decode");
    }

    bytes[index / 2] = byte;
  }

  return bytes;
}
