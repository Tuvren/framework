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

import type {
  BackendInvariantReclamationDeps,
  BackendInvariantReclamationValidationConfig,
  BackendState,
} from "../src/index.ts";

const importValidation = async () =>
  await import("../src/lib/backend-invariant-reclamation-validation.ts");
const importReclamation = async () =>
  await import("../src/lib/backend-invariant-reclamation.ts");
const importPublic = async () => await import("../src/index.ts");

const importOrder = process.env.TUVREN_BACKEND_SHARED_IMPORT_ORDER;

if (importOrder === undefined) {
  for (const order of ["direct-first", "public-first"] as const) {
    test(`preserves reclamation behavior when imports initialize ${order}`, () => {
      const result = spawnSync(process.execPath, ["test", import.meta.path], {
        cwd: import.meta.dir,
        encoding: "utf-8",
        env: { ...process.env, TUVREN_BACKEND_SHARED_IMPORT_ORDER: order },
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
  test("keeps canonical exports, empty summary, and first validation failure", async () => {
    let validation: Awaited<ReturnType<typeof importValidation>>;
    let reclamation: Awaited<ReturnType<typeof importReclamation>>;
    let publicApi: Awaited<ReturnType<typeof importPublic>>;

    if (importOrder === "direct-first") {
      validation = await importValidation();
      reclamation = await importReclamation();
      publicApi = await importPublic();
    } else {
      publicApi = await importPublic();
      validation = await importValidation();
      reclamation = await importReclamation();
    }

    expect(publicApi.createBackendInvariantReclamationValidation).toBe(
      validation.createBackendInvariantReclamationValidation
    );
    expect(publicApi.reclaimBackendState).toBe(reclamation.reclaimBackendState);

    const emptyState: BackendState = {
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
    };
    const noOpDeps: BackendInvariantReclamationDeps = {
      decodeHashStringArray: () => [],
      decodeRunCreatedTurnNodeHashes: () => [],
      decodeTurnNodeConsumedStagedResultObjectHashes: () => [],
      resolveStoredTurnTreePathValue: () => null,
    };

    expect(publicApi.reclaimBackendState(emptyState, noOpDeps, 0)).toEqual({
      releasedArchivedBranchCount: 0,
      releasedObjectCount: 0,
      releasedOrderedPathChunkCount: 0,
      releasedRunCount: 0,
      releasedTurnCount: 0,
      releasedTurnNodeCount: 0,
      releasedTurnTreeCount: 0,
      retainedObjectCount: 0,
    });

    const stateWithMissingBranchHead: BackendState = {
      ...emptyState,
      branches: new Map([
        [
          "branch_1",
          {
            branchId: "branch_1",
            createdAtMs: 0,
            headTurnNodeHash: "missing_node",
            threadId: "thread_1",
            updatedAtMs: 0,
          },
        ],
      ]),
    };
    const validationConfig: BackendInvariantReclamationValidationConfig = {
      decodeHashStringArray: () => [],
      decodeRunCreatedTurnNodeHashes: () => [],
      decodeTurnNodeConsumedStagedResultObjectHashes: () => [],
      errorPrefix: "proof",
      resolveStoredTurnTreePathValue: () => null,
    };
    const assertSurvivors =
      validation.createBackendInvariantReclamationValidation(validationConfig);
    let validationError: unknown;
    try {
      assertSurvivors.assertReclamationSurvivorInvariants(
        stateWithMissingBranchHead
      );
    } catch (error: unknown) {
      validationError = error;
    }

    expect(validationError).toMatchObject({
      code: "proof_backend_missing_turn_node_reference",
      details: { hash: "missing_node", label: "branch.headTurnNodeHash" },
    });
  });
}
