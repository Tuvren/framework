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

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { TuvrenPersistenceError } from "@tuvren/core";
import type {
  StoredBranch,
  StoredRun,
  StoredTurn,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";

import type {
  BackendInvariantStateValidationConfig,
  BackendState,
  ValidationHelpers,
} from "../src/index.ts";

const firstModules = [
  "../src/lib/backend-invariant-integrity-assertions.ts",
  "../src/lib/backend-invariant-phase-observer.ts",
  "../src/lib/backend-invariant-run-span.ts",
  "../src/lib/backend-invariant-state-validation.ts",
  "../src/lib/backend-invariant-turn-node-lineage.ts",
  "../src/index.ts",
] as const;

const firstModule = process.env.TUVREN_BACKEND_SHARED_REMAINING_FIRST_MODULE;

const createEmptyState = (): BackendState => ({
  branches: new Map(),
  objects: new Map(),
  observeAnnotations: new Map(),
  orderedPathChunks: new Map(),
  runs: new Map(),
  schemas: new Map(),
  stagedResults: new Map(),
  threads: new Map(),
  turnNodes: new Map(),
  turnTreePaths: new Map(),
  turnTrees: new Map(),
  turns: new Map(),
});

const failIfCalled = (): never => {
  throw new Error("unexpected validation helper call");
};

if (firstModule === undefined) {
  for (const modulePath of firstModules) {
    test(`preserves remaining invariant behavior when ${modulePath} initializes first`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          TUVREN_BACKEND_SHARED_REMAINING_FIRST_MODULE: modulePath,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain("1 pass");
      expect(result.stderr).toContain("0 fail");
    });
  }
} else {
  test("keeps canonical exports, closure timing, lineage, and first errors", async () => {
    await import(firstModule);

    const publicApi = await import("../src/index.ts");
    const integrityModule =
      await import("../src/lib/backend-invariant-integrity-assertions.ts");
    const phaseModule =
      await import("../src/lib/backend-invariant-phase-observer.ts");
    const runSpanModule =
      await import("../src/lib/backend-invariant-run-span.ts");
    const stateValidationModule =
      await import("../src/lib/backend-invariant-state-validation.ts");
    const lineageModule =
      await import("../src/lib/backend-invariant-turn-node-lineage.ts");

    expect(publicApi.createBackendInvariantIntegrityAssertions).toBe(
      integrityModule.createBackendInvariantIntegrityAssertions
    );
    expect(publicApi.listTurnsByThread).toBe(integrityModule.listTurnsByThread);
    expect(publicApi.createRecordingPhaseObserver).toBe(
      phaseModule.createRecordingPhaseObserver
    );
    expect(publicApi.createBackendInvariantRunSpan).toBe(
      runSpanModule.createBackendInvariantRunSpan
    );
    expect(publicApi.createBackendInvariantStateValidation).toBe(
      stateValidationModule.createBackendInvariantStateValidation
    );
    expect(publicApi.createBackendInvariantTurnNodeLineage).toBe(
      lineageModule.createBackendInvariantTurnNodeLineage
    );
    expect(publicApi.createTurnNodeLineageIndex).toBe(
      lineageModule.createTurnNodeLineageIndex
    );
    expect(publicApi.resolveTurnNodeLineagePosition).toBe(
      lineageModule.resolveTurnNodeLineagePosition
    );

    const observer = publicApi.createRecordingPhaseObserver();
    const endPhase = observer.startPhase("validate-committed");
    endPhase();
    endPhase();
    expect(observer.samples).toHaveLength(1);
    expect(observer.samples[0]).toMatchObject({
      phase: "validate-committed",
    });
    expect(observer.samples[0]?.durationNs).toBeGreaterThanOrEqual(0);

    const orderedTurnsState = createEmptyState();
    const laterTurn: StoredTurn = {
      branchId: "branch_1",
      createdAtMs: 2,
      headTurnNodeHash: "node_2",
      parentTurnId: "turn_a",
      startTurnNodeHash: "node_1",
      threadId: "thread_1",
      turnId: "turn_c",
      updatedAtMs: 2,
    };
    const sameTimeLaterId: StoredTurn = {
      ...laterTurn,
      createdAtMs: 1,
      turnId: "turn_b",
    };
    const firstTurn: StoredTurn = {
      ...laterTurn,
      createdAtMs: 1,
      parentTurnId: null,
      turnId: "turn_a",
    };
    orderedTurnsState.turns.set(laterTurn.turnId, laterTurn);
    orderedTurnsState.turns.set(sameTimeLaterId.turnId, sameTimeLaterId);
    orderedTurnsState.turns.set(firstTurn.turnId, firstTurn);

    expect(
      publicApi
        .listTurnsByThread(orderedTurnsState, "thread_1", "turn_b")
        .map((turn) => turn.turnId)
    ).toEqual(["turn_a", "turn_c"]);

    const rootNode: StoredTurnNode = {
      consumedStagedResultsCbor: new Uint8Array(),
      createdAtMs: 1,
      eventHash: null,
      hash: "node_root",
      previousTurnNodeHash: null,
      schemaId: "schema_1",
      turnTreeHash: "tree_1",
    };
    const childNode: StoredTurnNode = {
      ...rootNode,
      createdAtMs: 2,
      hash: "node_child",
      previousTurnNodeHash: rootNode.hash,
    };
    const nodes = new Map([
      [rootNode.hash, rootNode],
      [childNode.hash, childNode],
    ]);
    const lineageIndex = publicApi.createTurnNodeLineageIndex();
    const resolved = publicApi.resolveTurnNodeLineagePosition(
      nodes,
      childNode,
      lineageIndex,
      {
        onCycle: (): never => {
          throw new Error("unexpected lineage cycle");
        },
        onMissingPreviousTurnNode: (hash: string): never => {
          throw new Error(`unexpected missing lineage node: ${hash}`);
        },
      }
    );
    expect(resolved).toEqual({ depth: 1, rootTurnNodeHash: rootNode.hash });
    expect(lineageIndex.get(rootNode.hash)).toEqual({
      depth: 0,
      rootTurnNodeHash: rootNode.hash,
    });

    const runSpan = publicApi.createBackendInvariantRunSpan({
      decodeRunCreatedTurnNodeHashes: (_run: StoredRun) => [],
      errorPrefix: "proof",
    });
    let runSpanError: unknown;
    try {
      runSpan.classifyTurnNodeRelationship(
        createEmptyState(),
        "source_node",
        "target_node"
      );
    } catch (error: unknown) {
      runSpanError = error;
    }
    expect(runSpanError).toMatchObject({
      code: "proof_backend_missing_turn_node_reference",
      details: { hash: "target_node", label: "turnNodeHash" },
      message: "turnNodeHash must reference an existing turn node",
    });
    if (!(runSpanError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a TuvrenPersistenceError");
    }
    if (
      typeof runSpanError.details !== "object" ||
      runSpanError.details === null ||
      Array.isArray(runSpanError.details)
    ) {
      throw new TypeError("expected object-shaped persistence error details");
    }
    expect(Object.keys(runSpanError.details)).toEqual(["hash", "label"]);

    const validationConfig: BackendInvariantStateValidationConfig = {
      decodeHashStringArray: failIfCalled,
      decodeTurnTreeSchema: failIfCalled,
      errorPrefix: "proof",
    };
    const validation =
      publicApi.createBackendInvariantStateValidation(validationConfig);
    const helpers: ValidationHelpers = {
      assertActiveRunHeadAlignment: failIfCalled,
      assertBackwardBranchMoveIsArchived: failIfCalled,
      assertChunkedTurnTreePathChunkLayout: failIfCalled,
      assertRunCreatedTurnNodeWithinTurnSpan: failIfCalled,
      assertRunCreatedTurnNodesAreCanonical: failIfCalled,
      assertRunStartTurnNodeWithinTurnSpan: failIfCalled,
      assertTurnParentLink: failIfCalled,
      classifyTurnNodeRelationship: failIfCalled,
      decodeRunCreatedTurnNodeHashes: failIfCalled,
      decodeTurnNodeConsumedStagedResultObjectHashes: failIfCalled,
      validateHashString: failIfCalled,
    };
    const stateWithMissingThread = createEmptyState();
    const branch: StoredBranch = {
      branchId: "branch_1",
      createdAtMs: 1,
      headTurnNodeHash: rootNode.hash,
      threadId: "missing_thread",
      updatedAtMs: 1,
    };
    stateWithMissingThread.branches.set(branch.branchId, branch);
    let validationError: unknown;
    try {
      validation.validateCommittedState(
        stateWithMissingThread,
        createEmptyState(),
        helpers
      );
    } catch (error: unknown) {
      validationError = error;
    }

    expect(validationError).toMatchObject({
      code: "proof_backend_missing_thread_reference",
      details: { label: "branch.threadId", threadId: "missing_thread" },
      message: "branch.threadId must reference an existing thread",
    });
    if (!(validationError instanceof TuvrenPersistenceError)) {
      throw new TypeError("expected a TuvrenPersistenceError");
    }
    if (
      typeof validationError.details !== "object" ||
      validationError.details === null ||
      Array.isArray(validationError.details)
    ) {
      throw new TypeError("expected object-shaped persistence error details");
    }
    expect(Object.keys(validationError.details)).toEqual(["label", "threadId"]);
  });
}
