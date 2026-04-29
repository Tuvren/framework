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
    expect(canonicalKernelTestSchemaFixture.paths).toHaveLength(2);
  });

  test("keeps deterministic kernel fixture hashes and encodings aligned", async () => {
    const rawOpaqueBytes = Uint8Array.from(
      kernelProtocolDeterministicFixtures.rawOpaqueBytes
    );

    expect(await hashOpaqueObjectBytes(rawOpaqueBytes)).toBe(
      kernelProtocolDeterministicFixtures.rawOpaqueBytesSha256Hex
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
    expect(
      kernelProtocolLogicalFixtures.recoveryState.stepSequence
    ).toHaveLength(2);
    expect(
      kernelProtocolLogicalFixtures.turnTreeChangeSet.messages
    ).toHaveLength(2);
  });
});
