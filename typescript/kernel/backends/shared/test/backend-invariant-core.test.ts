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
import { createKernelBackendInvariantCore } from "@tuvren/backend-shared";
import { TuvrenPersistenceError } from "@tuvren/core";
import type { StoredRun, StoredTurnNode } from "@tuvren/kernel-protocol";

function createCore(errorPrefix: string) {
  return createKernelBackendInvariantCore({
    decodeHashStringArray: () => [],
    decodeRunCreatedTurnNodeHashes: (_run: StoredRun) => [],
    decodeTurnNodeConsumedStagedResultObjectHashes: (
      _turnNode: StoredTurnNode
    ) => [],
    errorPrefix,
    resolveStoredTurnTreePathValue: () => null,
  });
}

function captureThrownCode(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TuvrenPersistenceError);
    return (error as TuvrenPersistenceError).code;
  }
  throw new Error("expected fn() to throw a TuvrenPersistenceError");
}

describe("@tuvren/backend-shared createKernelBackendInvariantCore", () => {
  test("parameterizes record-utils error codes by errorPrefix, matching each backend's pre-extraction literal", () => {
    const memoryCore = createCore("memory");
    const postgresCore = createCore("postgres");
    const sqliteCore = createCore("sqlite");

    expect(
      captureThrownCode(() =>
        memoryCore.assertRunStatusTransition("completed", "running")
      )
    ).toBe("memory_backend_run_status_transition_illegal");
    expect(
      captureThrownCode(() =>
        postgresCore.assertRunStatusTransition("completed", "running")
      )
    ).toBe("postgres_backend_run_status_transition_illegal");
    expect(
      captureThrownCode(() =>
        sqliteCore.assertRunStatusTransition("completed", "running")
      )
    ).toBe("sqlite_backend_run_status_transition_illegal");
  });

  test("parameterizes run-logic error codes by errorPrefix, matching each backend's pre-extraction literal", () => {
    const memoryCore = createCore("memory");
    const postgresCore = createCore("postgres");

    const existingRun = {
      branchId: "branch_1",
      createdAtMs: 1,
      createdTurnNodesCbor: new Uint8Array(),
      currentStepIndex: 0,
      runId: "run_1",
      schemaId: "schema_1",
      startTurnNodeHash: "hash_1",
      status: "running",
      stepSequenceCbor: new Uint8Array(),
      turnId: "turn_1",
      updatedAtMs: 1,
    } as unknown as StoredRun;
    const nextRunWithDifferentBranch = {
      ...existingRun,
      branchId: "branch_2",
    } as StoredRun;

    expect(
      captureThrownCode(() =>
        memoryCore.assertRunUpdateIsLegal(
          existingRun,
          nextRunWithDifferentBranch
        )
      )
    ).toBe("memory_backend_run_branch_immutable");
    expect(
      captureThrownCode(() =>
        postgresCore.assertRunUpdateIsLegal(
          existingRun,
          nextRunWithDifferentBranch
        )
      )
    ).toBe("postgres_backend_run_branch_immutable");
  });
});
