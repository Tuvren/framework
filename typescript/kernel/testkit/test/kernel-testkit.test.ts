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

import { describe, expect, mock, test } from "bun:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  RuntimeBackend,
  RuntimeBackendTx,
  StoredBranch,
  StoredObject,
  StoredTurnNode,
} from "@tuvren/kernel-protocol";
import { encodeDeterministicKernelRecord } from "@tuvren/kernel-protocol";

import {
  createCanonicalKernelTestSchema,
  createCanonicalTurnTreePaths,
  createFaultInjectingBackend,
  createHashFromIndex,
  createStoredObjectRecord,
  createStoredSchemaRecord,
  createStoredTurnNodeRecord,
  createStoredTurnTreeRecord,
  registerBackendConformanceSuite,
  registerBackendInvariantSuite,
  registerBackendRecoverySuite,
} from "../src/index.ts";

const seedFaultInjectionBranch = async (
  backend: RuntimeBackend,
  branchId: string
): Promise<{
  branch: StoredBranch;
  childNode: StoredTurnNode;
  rootNode: StoredTurnNode;
}> => {
  const rootNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 12,
    eventHash: null,
    previousTurnNodeHash: null,
    schemaId: "schema_fault_injection",
    turnTreeHash: createHashFromIndex(99),
  });
  const childNode = await createStoredTurnNodeRecord({
    consumedStagedResults: [],
    createdAtMs: 13,
    eventHash: null,
    previousTurnNodeHash: rootNode.hash,
    schemaId: rootNode.schemaId,
    turnTreeHash: rootNode.turnTreeHash,
  });
  const branch: StoredBranch = {
    branchId,
    createdAtMs: 15,
    headTurnNodeHash: rootNode.hash,
    threadId: `${branchId}_thread`,
    updatedAtMs: 15,
  };

  await backend.transact(async (tx) => {
    await tx.turnNodes.put(rootNode);
    await tx.branches.set(branch);
  });

  return {
    branch,
    childNode,
    rootNode,
  };
};

const readBranch = async (
  backend: RuntimeBackend,
  branchId: string
): Promise<StoredBranch | null> =>
  await backend.transact(async (tx) => await tx.branches.get(branchId));

const readBranchHeadHash = async (
  backend: RuntimeBackend,
  branchId: string
): Promise<string | null> => {
  const branch = await readBranch(backend, branchId);
  return branch?.headTurnNodeHash ?? null;
};

const readTurnNode = async (
  backend: RuntimeBackend,
  turnNodeHash: string
): Promise<StoredTurnNode | null> =>
  await backend.transact(async (tx) => await tx.turnNodes.get(turnNodeHash));

const hasAncestor = (
  turnNodes: Map<string, StoredTurnNode>,
  startHash: string,
  ancestorHash: string
): boolean => {
  let current = turnNodes.get(startHash);

  while (current !== undefined && current.previousTurnNodeHash !== null) {
    if (current.previousTurnNodeHash === ancestorHash) {
      return true;
    }

    current = turnNodes.get(current.previousTurnNodeHash);
  }

  return false;
};

const classifyTurnNodeRelationship = (
  turnNodes: Map<string, StoredTurnNode>,
  sourceHash: string,
  targetHash: string
): "ancestor" | "descendant" | "lateral" | "same" => {
  if (sourceHash === targetHash) {
    return "same";
  }

  if (hasAncestor(turnNodes, targetHash, sourceHash)) {
    return "descendant";
  }

  if (hasAncestor(turnNodes, sourceHash, targetHash)) {
    return "ancestor";
  }

  return "lateral";
};

const createBranchHeadLateralMoveError = (
  previousHeadTurnNodeHash: string,
  nextHeadTurnNodeHash: string
): Error & { code: string } =>
  Object.assign(
    new Error(
      "record.headTurnNodeHash must remain on the same thread lineage as the current branch head"
    ),
    {
      code: "test_backend_branch_head_lateral_move",
      details: {
        nextHeadTurnNodeHash,
        previousHeadTurnNodeHash,
      },
    }
  );

interface FocusedTestBackend extends RuntimeBackend {
  inspect: () => {
    branches: Map<string, StoredBranch>;
    objects: Map<string, StoredObject>;
    turnNodes: Map<string, StoredTurnNode>;
  };
}

/** Focused single-branch unit fixture; real backend conformance lives in shared plans. */
const createTestBackend = (): FocusedTestBackend => {
  const faultControl = Symbol("fault-control");
  const state = {
    branches: new Map<string, StoredBranch>(),
    objects: new Map<string, StoredObject>(),
    turnNodes: new Map<string, StoredTurnNode>(),
  };
  let hooks: {
    afterCommitBeforeAck?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
    midCommit?: (commit: () => void) => Promise<void>;
  } | null = null;
  const readCommittedHead = (
    branch: StoredBranch | null
  ): StoredTurnNode | null =>
    branch === null
      ? null
      : (state.turnNodes.get(branch.headTurnNodeHash) ?? null);
  const backend = {
    [faultControl]: {
      setFaultHooks(nextHooks: typeof hooks) {
        hooks = nextHooks;
      },
      supportsFaultPoint() {
        return true;
      },
    },
    capabilities() {
      return { "thread.enumeration": false };
    },
    health: mock<RuntimeBackend["health"]>().mockResolvedValue({ ok: true }),
    inspect: () => structuredClone(state),
    async transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T> {
      const branch = state.branches.values().next().value ?? null;
      const head = readCommittedHead(branch);
      const tx = {
        branches: {
          get: mock<RuntimeBackendTx["branches"]["get"]>().mockResolvedValue(
            structuredClone(branch)
          ),
          listByThread: mock<
            RuntimeBackendTx["branches"]["listByThread"]
          >().mockResolvedValue([]),
          set: mock<RuntimeBackendTx["branches"]["set"]>().mockResolvedValue(),
        },
        objects: {
          get: mock<RuntimeBackendTx["objects"]["get"]>().mockResolvedValue(
            null
          ),
          has: mock<RuntimeBackendTx["objects"]["has"]>().mockResolvedValue(
            false
          ),
          put: mock<RuntimeBackendTx["objects"]["put"]>().mockResolvedValue(),
        },
        observeAnnotations: {
          listByRun: mock<
            RuntimeBackendTx["observeAnnotations"]["listByRun"]
          >().mockResolvedValue([]),
          set: mock<
            RuntimeBackendTx["observeAnnotations"]["set"]
          >().mockResolvedValue(),
        },
        orderedPathChunks: {
          get: mock<
            RuntimeBackendTx["orderedPathChunks"]["get"]
          >().mockResolvedValue(null),
          put: mock<
            RuntimeBackendTx["orderedPathChunks"]["put"]
          >().mockResolvedValue(),
        },
        runs: {
          get: mock<RuntimeBackendTx["runs"]["get"]>().mockResolvedValue(null),
          listByBranch: mock<
            RuntimeBackendTx["runs"]["listByBranch"]
          >().mockResolvedValue([]),
          listExpired: mock<
            RuntimeBackendTx["runs"]["listExpired"]
          >().mockResolvedValue([]),
          set: mock<RuntimeBackendTx["runs"]["set"]>().mockResolvedValue(),
        },
        schemas: {
          get: mock<RuntimeBackendTx["schemas"]["get"]>().mockResolvedValue(
            null
          ),
          put: mock<RuntimeBackendTx["schemas"]["put"]>().mockResolvedValue(),
        },
        stagedResults: {
          clearRun:
            mock<
              RuntimeBackendTx["stagedResults"]["clearRun"]
            >().mockResolvedValue(),
          get: mock<
            RuntimeBackendTx["stagedResults"]["get"]
          >().mockResolvedValue(null),
          listByRun: mock<
            RuntimeBackendTx["stagedResults"]["listByRun"]
          >().mockResolvedValue([]),
          set: mock<
            RuntimeBackendTx["stagedResults"]["set"]
          >().mockResolvedValue(),
        },
        threads: {
          get: mock<RuntimeBackendTx["threads"]["get"]>().mockResolvedValue(
            null
          ),
          put: mock<RuntimeBackendTx["threads"]["put"]>().mockResolvedValue(),
        },
        turnNodes: {
          get: mock<RuntimeBackendTx["turnNodes"]["get"]>().mockResolvedValue(
            structuredClone(head)
          ),
          put: mock<RuntimeBackendTx["turnNodes"]["put"]>().mockResolvedValue(),
        },
        turnTreePaths: {
          get: mock<
            RuntimeBackendTx["turnTreePaths"]["get"]
          >().mockResolvedValue(null),
          listByTurnTree: mock<
            RuntimeBackendTx["turnTreePaths"]["listByTurnTree"]
          >().mockResolvedValue([]),
          putMany:
            mock<
              RuntimeBackendTx["turnTreePaths"]["putMany"]
            >().mockResolvedValue(),
        },
        turnTrees: {
          get: mock<RuntimeBackendTx["turnTrees"]["get"]>().mockResolvedValue(
            null
          ),
          put: mock<RuntimeBackendTx["turnTrees"]["put"]>().mockResolvedValue(),
        },
        turns: {
          get: mock<RuntimeBackendTx["turns"]["get"]>().mockResolvedValue(null),
          listByThread: mock<
            RuntimeBackendTx["turns"]["listByThread"]
          >().mockResolvedValue([]),
          set: mock<RuntimeBackendTx["turns"]["set"]>().mockResolvedValue(),
        },
      };
      let result: T;
      try {
        result = await work(tx);
      } finally {
        for (const args of tx.branches.get.mock.calls) {
          strictEqual(args.length, 1, "focused branch read has one argument");
          const [branchId] = args;
          strictEqual(
            branchId,
            branch?.branchId,
            "focused fixture only reads the committed branch"
          );
        }
        for (const args of tx.turnNodes.get.mock.calls) {
          strictEqual(args.length, 1, "focused head read has one argument");
          const [hash] = args;
          strictEqual(
            hash,
            branch?.headTurnNodeHash,
            "focused fixture only reads the committed head"
          );
        }
        for (const calls of [
          tx.branches.listByThread.mock.calls,
          tx.objects.get.mock.calls,
          tx.objects.has.mock.calls,
          tx.observeAnnotations.listByRun.mock.calls,
          tx.observeAnnotations.set.mock.calls,
          tx.orderedPathChunks.get.mock.calls,
          tx.orderedPathChunks.put.mock.calls,
          tx.runs.get.mock.calls,
          tx.runs.listByBranch.mock.calls,
          tx.runs.listExpired.mock.calls,
          tx.runs.set.mock.calls,
          tx.schemas.get.mock.calls,
          tx.schemas.put.mock.calls,
          tx.stagedResults.clearRun.mock.calls,
          tx.stagedResults.get.mock.calls,
          tx.stagedResults.listByRun.mock.calls,
          tx.stagedResults.set.mock.calls,
          tx.threads.get.mock.calls,
          tx.threads.put.mock.calls,
          tx.turnTreePaths.get.mock.calls,
          tx.turnTreePaths.listByTurnTree.mock.calls,
          tx.turnTreePaths.putMany.mock.calls,
          tx.turnTrees.get.mock.calls,
          tx.turnTrees.put.mock.calls,
          tx.turns.get.mock.calls,
          tx.turns.listByThread.mock.calls,
          tx.turns.set.mock.calls,
        ]) {
          strictEqual(
            calls.length,
            0,
            "unsupported focused fixture repository call"
          );
        }
      }
      const draft = {
        branches: new Map(state.branches),
        objects: new Map(state.objects),
        turnNodes: new Map(state.turnNodes),
      };
      for (const args of tx.objects.put.mock.calls) {
        strictEqual(args.length, 1, "focused fixture writes have one record");
        const [record] = args;
        draft.objects.set(record.hash, structuredClone(record));
      }
      for (const args of tx.turnNodes.put.mock.calls) {
        strictEqual(args.length, 1, "focused fixture writes have one record");
        const [record] = args;
        draft.turnNodes.set(record.hash, structuredClone(record));
      }
      for (const args of tx.branches.set.mock.calls) {
        strictEqual(args.length, 1, "focused fixture writes have one record");
        const [record] = args;
        const existing = draft.branches.get(record.branchId);
        if (
          existing !== undefined &&
          classifyTurnNodeRelationship(
            draft.turnNodes,
            existing.headTurnNodeHash,
            record.headTurnNodeHash
          ) === "lateral"
        ) {
          throw createBranchHeadLateralMoveError(
            existing.headTurnNodeHash,
            record.headTurnNodeHash
          );
        }
        draft.branches.set(record.branchId, structuredClone(record));
      }
      strictEqual(
        draft.branches.size <= 1,
        true,
        "focused fixture supports one branch"
      );
      await hooks?.beforeCommit?.();
      let committed = false;
      const commit = (): void => {
        strictEqual(
          committed,
          false,
          "test backend commit hook attempted double commit"
        );
        state.branches = draft.branches;
        state.objects = draft.objects;
        state.turnNodes = draft.turnNodes;
        committed = true;
      };
      if (hooks?.midCommit === undefined) {
        commit();
      } else {
        await hooks.midCommit(commit);
        if (!committed) {
          throw new Error("test backend mid-commit hook must commit once");
        }
      }
      await hooks?.afterCommitBeforeAck?.();
      return result;
    },
  };
  return backend;
};

describe("@tuvren/kernel-testkit fixtures", () => {
  test("creates the canonical kernel test schema", () => {
    deepStrictEqual(createCanonicalKernelTestSchema(), {
      incorporationRules: [
        {
          objectType: "message",
          targetPath: "messages",
        },
        {
          objectType: "context_manifest",
          targetPath: "context.manifest",
        },
      ],
      paths: [
        {
          collection: "ordered",
          path: "messages",
        },
        {
          collection: "single",
          path: "context.manifest",
        },
      ],
      schemaId: "schema_main",
    });
  });

  test("creates deterministic stored records for canonical fixtures", async () => {
    const schema = createCanonicalKernelTestSchema();
    const storedSchema = createStoredSchemaRecord(schema, 1);
    const storedObject = await createStoredObjectRecord(
      new Uint8Array([1, 2]),
      2
    );
    const storedTurnTree = await createStoredTurnTreeRecord(
      schema,
      {
        "context.manifest": null,
        messages: [storedObject.hash],
      },
      3
    );
    const storedTurnNode = await createStoredTurnNodeRecord({
      consumedStagedResults: [],
      createdAtMs: 4,
      eventHash: null,
      previousTurnNodeHash: null,
      schemaId: schema.schemaId,
      turnTreeHash: storedTurnTree.hash,
    });

    strictEqual(storedSchema.schemaId, schema.schemaId);
    strictEqual(storedObject.byteLength, 2);
    strictEqual(storedTurnTree.schemaId, schema.schemaId);
    strictEqual(storedTurnNode.previousTurnNodeHash, null);
  });

  test("creates canonical path rows for ordered and single paths", async () => {
    const schema = createCanonicalKernelTestSchema();
    const storedTurnTree = await createStoredTurnTreeRecord(
      schema,
      {
        "context.manifest": null,
        messages: [createHashFromIndex(1)],
      },
      1
    );

    deepStrictEqual(
      createCanonicalTurnTreePaths(storedTurnTree, {
        "context.manifest": null,
        messages: [createHashFromIndex(1)],
      }),
      [
        {
          collectionKind: "single",
          path: "context.manifest",
          singleHash: null,
          turnTreeHash: storedTurnTree.hash,
        },
        {
          collectionKind: "ordered",
          orderedCount: 1,
          orderedEncoding: "flat",
          orderedInlineCbor: encodeDeterministicKernelRecord([
            createHashFromIndex(1),
          ]),
          path: "messages",
          turnTreeHash: storedTurnTree.hash,
        },
      ]
    );
  });

  test("registers the shared suite entrypoints without executing them eagerly", () => {
    const registrations: { kind: "describe" | "test"; name: string }[] = [];
    const testApi = {
      describe(name: string, register: () => void) {
        registrations.push({ kind: "describe", name });
        register();
      },
      test(name: string) {
        registrations.push({ kind: "test", name });
      },
    };

    registerBackendConformanceSuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "conformance smoke",
      testApi,
    });
    registerBackendInvariantSuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "invariant smoke",
      testApi,
    });
    registerBackendRecoverySuite({
      createBackend: () => {
        throw new Error("should not be called during registration");
      },
      suiteName: "recovery smoke",
      testApi,
    });

    expect(
      registrations.some((entry) => entry.name === "conformance smoke")
    ).toBe(true);
    expect(
      registrations.some((entry) => entry.name === "invariant smoke")
    ).toBe(true);
    expect(registrations.some((entry) => entry.name === "recovery smoke")).toBe(
      true
    );
    expect(registrations.some((entry) => entry.kind === "test")).toBe(true);
  });

  test("exports the fault injection seam and keeps it out of production paths", () => {
    expect(typeof createFaultInjectingBackend).toBe("function");

    const repositoryRoot = fileURLToPath(
      new URL("../../../../", import.meta.url)
    );
    const search = spawnSync(
      "rg",
      [
        "-n",
        "@tuvren/kernel-testkit|createFaultInjectingBackend|FaultPlan",
        "typescript",
        "-g",
        "!**/dist/**",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf-8",
      }
    );

    if (search.error !== undefined) {
      throw search.error;
    }

    const unexpectedMatches = search.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .filter(
        (line) =>
          !(
            line.includes("/testkit/") ||
            line.includes("/conformance-adapter/") ||
            line.includes("/test/") ||
            line.includes("/bench/") ||
            line.includes("package.json:") ||
            // Changeset-generated release notes list dependency bumps by
            // package name; documentation, not a production import path.
            line.includes("CHANGELOG.md:")
          )
      );

    expect(unexpectedMatches).toEqual([]);
  });

  test("injects once for the matching checkpoint branch and lets the retry commit", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_once");
    const faultBackend = createFaultInjectingBackend(backend, {
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "once",
    });

    const writeChildHead = async (target: RuntimeBackend): Promise<void> => {
      await target.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      });
    };

    await rejects(writeChildHead(faultBackend), {
      code: "kernel_persistence_fault_injected",
    });
    await writeChildHead(faultBackend);

    const branchHead = await readBranchHeadHash(
      backend,
      seeded.branch.branchId
    );
    expect(branchHead).toBe(seeded.childNode.hash);
  });

  test("repeats matching injections when the policy is always", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_always");
    const faultBackend = createFaultInjectingBackend(backend, {
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "always",
    });

    const writeChildHead = async (): Promise<void> => {
      await faultBackend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      });
    };

    await rejects(writeChildHead(), {
      code: "kernel_persistence_fault_injected",
    });
    await rejects(writeChildHead(), {
      code: "kernel_persistence_fault_injected",
    });

    const branchHead = await readBranchHeadHash(
      backend,
      seeded.branch.branchId
    );
    expect(branchHead).toBe(seeded.branch.headTurnNodeHash);
  });

  test("skips injection when the branch match does not apply", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_match_skip");
    const faultBackend = createFaultInjectingBackend(backend, {
      match: {
        branchId: "branch_other",
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "once",
    });

    await faultBackend.transact(async (tx) => {
      await tx.turnNodes.put(seeded.childNode);
      await tx.branches.set({
        ...seeded.branch,
        headTurnNodeHash: seeded.childNode.hash,
        updatedAtMs: seeded.branch.updatedAtMs + 1,
      });
    });

    const branchHead = await readBranchHeadHash(
      backend,
      seeded.branch.branchId
    );
    expect(branchHead).toBe(seeded.childNode.hash);
  });

  test("simulates the configured concurrent writer when the wrapped commit aborts", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(
      backend,
      "branch_concurrent_writer"
    );
    const faultBackend = createFaultInjectingBackend(backend, {
      concurrentWriter: {
        branchId: seeded.branch.branchId,
      },
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "before-commit",
      policy: "once",
    });

    await rejects(
      faultBackend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      }),
      { code: "kernel_persistence_fault_injected" }
    );

    const finalBranch = await readBranch(backend, seeded.branch.branchId);

    if (finalBranch === null) {
      throw new Error("expected seeded branch after concurrent writer run");
    }

    const finalHead = await readTurnNode(backend, finalBranch.headTurnNodeHash);

    if (finalHead === null) {
      throw new Error("expected concurrent writer head turn node");
    }

    expect(finalBranch.headTurnNodeHash).not.toBe(
      seeded.branch.headTurnNodeHash
    );
    expect(finalBranch.headTurnNodeHash).not.toBe(seeded.childNode.hash);
    expect(finalHead.previousTurnNodeHash).toBe(seeded.rootNode.hash);
  });

  test("preserves the injected fault when the concurrent writer also fails", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(
      backend,
      "branch_concurrent_writer_mid_commit"
    );
    const faultBackend = createFaultInjectingBackend(backend, {
      concurrentWriter: {
        branchId: seeded.branch.branchId,
      },
      match: {
        branchId: seeded.branch.branchId,
        operation: "checkpoint",
      },
      point: "after-commit-before-ack",
      policy: "once",
    });

    await rejects(
      faultBackend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        await tx.branches.set({
          ...seeded.branch,
          headTurnNodeHash: seeded.childNode.hash,
          updatedAtMs: seeded.branch.updatedAtMs + 1,
        });
      }),
      { code: "kernel_persistence_fault_injected" }
    );

    const finalBranch = await readBranch(backend, seeded.branch.branchId);

    if (finalBranch === null) {
      throw new Error("expected branch after preserved mid-commit fault");
    }

    expect(finalBranch.headTurnNodeHash).toBe(seeded.childNode.hash);
  });
  test("preserves optional maintenance receivers, results, errors and absence", async () => {
    const success = { extra: "preserved", ok: true } as const;
    const failure = { ok: false, reason: "damaged index" } as const;
    const domainError = new Error("fsck backend failure");
    await Promise.all(
      [success, failure, domainError].map(async (expected) => {
        const close = mock<() => Promise<void>>().mockResolvedValue();
        const destroy =
          mock<
            (options?: { dropSchema?: boolean }) => Promise<void>
          >().mockResolvedValue();
        const fsck = mock<() => Promise<typeof success | typeof failure>>();
        if (expected instanceof Error) {
          fsck.mockRejectedValue(expected);
        } else {
          fsck.mockResolvedValue(expected);
        }
        const backend = Object.assign(createTestBackend(), {
          close,
          destroy,
          fsck,
        });
        const wrapped = createFaultInjectingBackend(backend, {
          point: "before-commit",
          policy: "once",
        });
        const invoke = async (key: string): Promise<unknown> => {
          const method: unknown = Reflect.get(wrapped, key);
          if (typeof method !== "function") {
            throw new TypeError("expected forwarded maintenance method");
          }
          return await method.apply(
            wrapped,
            key === "destroy" ? [{ dropSchema: true }] : []
          );
        };
        strictEqual(await invoke("close"), undefined);
        strictEqual(await invoke("destroy"), undefined);
        if (expected instanceof Error) {
          await rejects(invoke("fsck"), (error: unknown) => {
            strictEqual(error, expected);
            return true;
          });
        } else {
          strictEqual(await invoke("fsck"), expected);
        }
        deepStrictEqual(close.mock.calls, [[]]);
        deepStrictEqual(destroy.mock.calls, [[{ dropSchema: true }]]);
        deepStrictEqual(fsck.mock.calls, [[]]);
        strictEqual(close.mock.contexts[0], backend);
        strictEqual(destroy.mock.contexts[0], backend);
        strictEqual(fsck.mock.contexts[0], backend);
      })
    );
    const absent = createFaultInjectingBackend(createTestBackend(), {
      point: "before-commit",
      policy: "once",
    });
    for (const key of ["close", "destroy", "fsck", "reclaim", "purgeScope"]) {
      strictEqual(key in absent, false);
    }
  });
  test("validates unknown fsck results without changing valid result objects", async () => {
    const backend = Object.assign(createTestBackend(), {
      fsck: mock<() => Promise<unknown>>().mockResolvedValue({ ok: false }),
    });
    const wrapped = createFaultInjectingBackend(backend, {
      point: "before-commit",
      policy: "once",
    });
    const method: unknown = Reflect.get(wrapped, "fsck");
    if (typeof method !== "function") {
      throw new TypeError("expected forwarded fsck method");
    }
    await rejects(
      async () => {
        await method.call(wrapped);
      },
      {
        message: "backend fsck must return an ok result or a failure reason",
        name: "TypeError",
      }
    );
  });

  test("clears installed hooks before propagating transaction errors", async () => {
    const actualError = new Error("backend transaction failed");
    const calls: string[] = [];
    const control = {
      setFaultHooks(hooks: object | null) {
        calls.push(hooks === null ? "clear" : "install");
      },
      supportsFaultPoint() {
        return true;
      },
    };
    const backend: RuntimeBackend = {
      capabilities() {
        return { "thread.enumeration": false };
      },
      health: createTestBackend().health,
      async transact<T>(
        _work: (tx: RuntimeBackendTx) => Promise<T>
      ): Promise<T> {
        calls.push("transaction");
        return await Promise.reject<T>(actualError);
      },
    };
    Object.defineProperty(backend, Symbol("fault-control"), { value: control });
    const wrapped = createFaultInjectingBackend(backend, {
      point: "before-commit",
      policy: "once",
    });
    await rejects(
      wrapped.transact(async (tx) => await tx.branches.get("missing")),
      (error: unknown) => {
        deepStrictEqual(calls, ["install", "transaction", "clear"]);
        strictEqual(error, actualError);
        return true;
      }
    );
  });
  test("focused fixture rejects unsupported reads even when work fails", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(backend, "branch_focused");
    const before = backend.inspect();
    await rejects(
      backend.transact(async (tx) => await tx.branches.get("unsupported")),
      { message: /focused fixture only reads the committed branch/u }
    );
    await rejects(
      backend.transact(async (tx) => {
        await tx.objects.get("unsupported");
        throw new Error("work failed");
      }),
      { message: /unsupported focused fixture repository call/u }
    );
    await rejects(
      backend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        return await tx.turnNodes.get(seeded.childNode.hash);
      }),
      { message: /focused fixture only reads the committed head/u }
    );
    deepStrictEqual(backend.inspect(), before);
  });

  test("focused fixture discards recorded writes when work rejects", async () => {
    const backend = createTestBackend();
    const seeded = await seedFaultInjectionBranch(
      backend,
      "branch_work_reject"
    );
    const before = backend.inspect();
    const failure = new Error("callback failed");
    await rejects(
      backend.transact(async (tx) => {
        await tx.turnNodes.put(seeded.childNode);
        throw failure;
      }),
      (error: unknown) => {
        strictEqual(error, failure);
        return true;
      }
    );
    deepStrictEqual(backend.inspect(), before);
  });
});
