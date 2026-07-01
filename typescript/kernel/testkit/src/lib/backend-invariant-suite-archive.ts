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

import { rejects } from "node:assert/strict";
import { TuvrenPersistenceError } from "@tuvren/core";
import type { StoredBranch, StoredThread } from "@tuvren/kernel-protocol";
import type { BackendConformanceSuiteOptions } from "./backend-test-suite-types.js";
import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
} from "./kernel-test-fixtures.js";

export function registerBackendInvariantArchiveCases(
  options: BackendConformanceSuiteOptions
): void {
  options.testApi.test("rejects forged archive branches", async () => {
    const { backend, branch, headNode, middleNode, thread } =
      await createArchiveRollbackScenario(options);

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          archivedFromBranchId: branch.branchId,
          branchId: "branch_forged_archive",
          createdAtMs: 8,
          headTurnNodeHash: middleNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 8,
        });
      }),
      TuvrenPersistenceError
    );

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          archivedFromBranchId: branch.branchId,
          branchId: "branch_forged_archive_same_head",
          createdAtMs: 9,
          headTurnNodeHash: headNode.hash,
          threadId: thread.threadId,
          updatedAtMs: 9,
        });
      }),
      TuvrenPersistenceError
    );
  });

  options.testApi.test("rejects stale archival rollback state", async () => {
    const { backend, branch, headNode, middleNode, rootNode, thread } =
      await createArchiveRollbackScenario(options);

    await backend.transact(async (tx) => {
      await tx.branches.set({
        ...branch,
        headTurnNodeHash: middleNode.hash,
        updatedAtMs: 8,
      });
      await tx.branches.set({
        archivedFromBranchId: branch.branchId,
        branchId: "branch_stale_archive",
        createdAtMs: 8,
        headTurnNodeHash: headNode.hash,
        threadId: thread.threadId,
        updatedAtMs: 8,
      });
    });

    await rejects(
      backend.transact(async (tx) => {
        await tx.branches.set({
          ...branch,
          headTurnNodeHash: rootNode.hash,
          updatedAtMs: 9,
        });
      }),
      TuvrenPersistenceError
    );
  });
}

export async function createArchiveRollbackFixtures(): Promise<{
  branch: StoredBranch;
  headNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  middleNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  rootNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  schema: ReturnType<typeof createCanonicalKernelTestSchema>;
  schemaRecord: ReturnType<typeof createStoredSchemaRecord>;
  thread: StoredThread;
  turnTree: Awaited<ReturnType<typeof createStoredTurnTreeRecord>>;
}> {
  const schema = createCanonicalKernelTestSchema();
  const schemaRecord = createStoredSchemaRecord(schema, 1);
  const turnTree = await createStoredTurnTreeRecord(
    schema,
    { "context.manifest": null, messages: [] },
    2
  );
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 3,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const middleNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 4,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const headNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 5,
    eventHash: null,
    previousTurnNodeHash: middleNode.hash,
    schemaId: schema.schemaId,
    turnTreeHash: turnTree.hash,
  });
  const thread: StoredThread = {
    createdAtMs: 6,
    rootTurnNodeHash: rootNode.hash,
    schemaId: schema.schemaId,
    threadId: "thread_archive_provenance",
  };
  const branch: StoredBranch = {
    branchId: "branch_archive_provenance",
    createdAtMs: 7,
    headTurnNodeHash: headNode.hash,
    threadId: thread.threadId,
    updatedAtMs: 7,
  };

  return {
    branch,
    headNode,
    middleNode,
    rootNode,
    schema,
    schemaRecord,
    thread,
    turnTree,
  };
}

async function createArchiveRollbackScenario(
  options: BackendConformanceSuiteOptions
): Promise<{
  backend: ReturnType<BackendConformanceSuiteOptions["createBackend"]>;
  branch: StoredBranch;
  headNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  middleNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  rootNode: Awaited<ReturnType<typeof createStoredTurnNodeRecord>>;
  schema: ReturnType<typeof createCanonicalKernelTestSchema>;
  schemaRecord: ReturnType<typeof createStoredSchemaRecord>;
  thread: StoredThread;
  turnTree: Awaited<ReturnType<typeof createStoredTurnTreeRecord>>;
}> {
  const backend = options.createBackend();
  const fixtures = await createArchiveRollbackFixtures();

  await backend.transact(async (tx) => {
    await tx.schemas.put(fixtures.schemaRecord);
    await tx.turnTrees.put(fixtures.turnTree);
    await tx.turnTreePaths.putMany(
      createCanonicalTurnTreePaths(fixtures.turnTree, {
        "context.manifest": null,
        messages: [],
      })
    );
    await tx.turnNodes.put(fixtures.rootNode);
    await tx.turnNodes.put(fixtures.middleNode);
    await tx.turnNodes.put(fixtures.headNode);
    await tx.threads.put(fixtures.thread);
    await tx.branches.set(fixtures.branch);
  });

  return {
    backend,
    ...fixtures,
  };
}
