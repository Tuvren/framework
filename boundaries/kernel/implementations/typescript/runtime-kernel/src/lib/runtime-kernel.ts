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

import { randomUUID } from "node:crypto";
import {
  type EpochMs,
  TuvrenLineageError,
  TuvrenPersistenceError,
  TuvrenRuntimeError,
  TuvrenValidationError,
} from "@tuvren/core";
import {
  assertTurnTreeSchema,
  type BranchHeadListEntry,
  type KernelThreadListCursor,
  type ListThreadsCursorPayload,
  type ReclamationOptions,
  type ReclamationSummary,
  type RuntimeBackend,
  type RuntimeKernel,
  type RuntimeKernelRunLiveness,
  type SetHeadResult,
  type StoredBranch,
  type StoredTurn,
  type ThreadCreateResult,
  type TurnTreeManifest,
} from "@tuvren/kernel-protocol";
import {
  allocateArchiveBranchId,
  applyStagedResultsToManifest,
  assertNoActiveBranchRunForForwardHeadMove,
  assertTurnHeadRewritePreservesDependents,
  classifyHeadMovement,
  collectAbandonedSegmentHashes,
  composeModifyVerdict,
  createTurnNode,
  createTurnTree,
  runTouchesSegment,
  turnNodeDescendsFrom,
  validateStagedResultsHaveRules,
  validateTurnParent,
  validateTurnTreeChangeSet,
  walkBack,
} from "./runtime-kernel-lineage.js";
import {
  createRuntimeKernelRunApi,
  createRuntimeKernelRunLivenessApi,
} from "./runtime-kernel-runs.js";
import {
  assertBranchIdAvailable,
  assertThreadCreateIdsAvailable,
  assertTurnIdAvailable,
  createEmptyManifest,
  createStagedResult,
  decodeSchema,
  decodeStoredTurnNode,
  encodeRecord,
  listStagedResults,
  putObject,
  requireBranch,
  requireRun,
  requireSchema,
  requireStoredTurn,
  requireThread,
  requireThreadTurnNode,
  requireTreeManifest,
  requireTurnTree,
  toBranchRecord,
  toStoredStagedResult,
  toTurnRecord,
} from "./runtime-kernel-storage.js";

function encodeCursor(
  payload: ListThreadsCursorPayload
): KernelThreadListCursor {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: KernelThreadListCursor
): ListThreadsCursorPayload {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new TuvrenValidationError(
      "thread.list cursor is not valid base64url",
      {
        code: "invalid_durable_read_cursor",
      }
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TuvrenValidationError(
      "thread.list cursor payload is not valid JSON",
      {
        code: "invalid_durable_read_cursor",
      }
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as ListThreadsCursorPayload).v !== 1 ||
    (parsed as ListThreadsCursorPayload).kind !== "list-threads" ||
    typeof (parsed as ListThreadsCursorPayload).lastThreadId !== "string" ||
    typeof (parsed as ListThreadsCursorPayload).lastCreatedAtMs !== "number"
  ) {
    throw new TuvrenValidationError(
      "thread.list cursor payload has unexpected shape",
      {
        code: "invalid_durable_read_cursor",
      }
    );
  }
  return parsed as ListThreadsCursorPayload;
}

export interface RuntimeKernelOptions {
  backend: RuntimeBackend;
  createFencingToken?: () => string;
  now?: () => EpochMs;
}

export function createRuntimeKernel(
  options: RuntimeKernelOptions
): RuntimeKernel & RuntimeKernelRunLiveness {
  const now = options.now ?? (() => Date.now() as EpochMs);
  const backend = options.backend;
  const createFencingToken = options.createFencingToken ?? randomUUID;

  return {
    branch: {
      async create(branchId, threadId, fromTurnNodeHash) {
        return await backend.transact(async (tx) => {
          await assertBranchIdAvailable(tx, branchId);
          const thread = await requireThread(tx, threadId);
          await requireThreadTurnNode(tx, fromTurnNodeHash, thread);
          const record: StoredBranch = {
            branchId,
            createdAtMs: now(),
            headTurnNodeHash: fromTurnNodeHash,
            threadId,
            updatedAtMs: now(),
          };
          await tx.branches.set(record);
          return toBranchRecord(record);
        });
      },

      async get(branchId) {
        return await backend.transact(async (tx) => {
          const branch = await tx.branches.get(branchId);
          return branch === null ? null : toBranchRecord(branch);
        });
      },

      async list(threadId) {
        return await backend.transact(async (tx) => {
          await requireThread(tx, threadId);
          const branches = await tx.branches.listByThread(threadId);
          return branches.map(
            (branch): BranchHeadListEntry => [
              branch.branchId,
              branch.headTurnNodeHash,
            ]
          );
        });
      },

      async setHead(branchId, turnNodeHash) {
        return await backend.transact(async (tx) => {
          const branch = await requireBranch(tx, branchId);
          const thread = await requireThread(tx, branch.threadId);
          await requireThreadTurnNode(tx, turnNodeHash, thread);

          const currentHead = branch.headTurnNodeHash;

          if (currentHead === turnNodeHash) {
            return { branch: toBranchRecord(branch) } satisfies SetHeadResult;
          }

          const direction = await classifyHeadMovement(
            tx,
            currentHead,
            turnNodeHash
          );

          if (direction === "lateral") {
            throw new TuvrenLineageError(
              `branch.setHead cannot move laterally: "${currentHead}" and "${turnNodeHash}" share no lineage`,
              { code: "kernel_runtime_lateral_head_movement" }
            );
          }

          if (direction === "forward") {
            await assertNoActiveBranchRunForForwardHeadMove(tx, branch);
            const updated: StoredBranch = {
              ...branch,
              headTurnNodeHash: turnNodeHash,
              updatedAtMs: now(),
            };
            await tx.branches.set(updated);
            return { branch: toBranchRecord(updated) } satisfies SetHeadResult;
          }

          // Backward: atomic archival rollback
          const abandonedSegmentHashes = await collectAbandonedSegmentHashes(
            tx,
            currentHead,
            turnNodeHash
          );
          const archiveOrdinal =
            (await tx.branches.listByThread(branch.threadId)).filter(
              (candidate) => candidate.archivedFromBranchId === branchId
            ).length + 1;
          const archiveBranchId = await allocateArchiveBranchId(tx, {
            branchId,
            currentHead,
            initialOrdinal: archiveOrdinal,
          });
          const archiveBranch: StoredBranch = {
            archivedFromBranchId: branchId,
            branchId: archiveBranchId,
            createdAtMs: now(),
            headTurnNodeHash: currentHead,
            threadId: branch.threadId,
            updatedAtMs: now(),
          };
          await tx.branches.set(archiveBranch);

          // Fail all running/paused runs on the abandoned segment
          const branchRuns = await tx.runs.listByBranch(branchId);
          for (const storedRun of branchRuns) {
            if (
              (storedRun.status === "running" ||
                storedRun.status === "paused") &&
              runTouchesSegment(storedRun, abandonedSegmentHashes)
            ) {
              // Backward rollback must leave touched runs terminal and clean in
              // one transaction, or backend invariants reject the rewind.
              await tx.stagedResults.clearRun(storedRun.runId);
              await tx.runs.set({
                ...storedRun,
                status: "failed",
                updatedAtMs: now(),
              });
            }
          }

          const updated: StoredBranch = {
            ...branch,
            headTurnNodeHash: turnNodeHash,
            updatedAtMs: now(),
          };
          await tx.branches.set(updated);

          return {
            archiveBranch: toBranchRecord(archiveBranch),
            branch: toBranchRecord(updated),
          } satisfies SetHeadResult;
        });
      },
    },

    maintenance: {
      async reclaim(options?: ReclamationOptions): Promise<ReclamationSummary> {
        if (!backend.capabilities()["maintenance.reclamation"]) {
          throw new TuvrenPersistenceError(
            "maintenance.reclamation is not supported by this backend",
            { code: "kernel_capability_unsupported" }
          );
        }
        if (backend.reclaim === undefined) {
          throw new TuvrenPersistenceError(
            "backend advertises maintenance.reclamation but does not implement reclaim",
            { code: "kernel_capability_unsupported" }
          );
        }
        return await backend.reclaim({ nowMs: options?.nowMs ?? now() });
      },
    },

    node: {
      async get(hash) {
        return await backend.transact(async (tx) => {
          const node = await tx.turnNodes.get(hash);
          return node === null ? null : decodeStoredTurnNode(node);
        });
      },

      walkBack(fromHash) {
        return walkBack(backend, fromHash);
      },
    },

    run: createRuntimeKernelRunApi({
      backend,
      createFencingToken,
      now,
    }),

    runLiveness: createRuntimeKernelRunLivenessApi({
      backend,
      createFencingToken,
      now,
    }),

    schema: {
      async get(schemaId) {
        return await backend.transact(async (tx) => {
          const schema = await tx.schemas.get(schemaId);
          return schema === null ? null : decodeSchema(schema.schemaCbor);
        });
      },

      async register(schema) {
        return await backend.transact(async (tx) => {
          assertTurnTreeSchema(schema, "schema");
          const existing = await tx.schemas.get(schema.schemaId);

          if (existing !== null) {
            // The frozen kernel surface treats schema IDs as write-once
            // identities, so even byte-for-byte duplicate registrations must
            // fail instead of becoming an idempotent upsert.
            throw new TuvrenValidationError(
              `schema "${schema.schemaId}" is already registered`,
              { code: "kernel_runtime_duplicate_schema" }
            );
          }

          await tx.schemas.put({
            createdAtMs: now(),
            schemaCbor: encodeRecord(schema),
            schemaId: schema.schemaId,
          });
          return schema.schemaId;
        });
      },
    },

    staging: {
      async current(runId) {
        return await backend.transact(async (tx) => {
          await requireRun(tx, runId);
          return await listStagedResults(tx, runId);
        });
      },

      async stage(runId, blob, taskId, objectType, status, interruptPayload) {
        return await backend.transact(async (tx) => {
          const run = await requireRun(tx, runId);

          if (run.status !== "running") {
            throw new TuvrenRuntimeError(
              `run "${runId}" is not in running state (status: ${run.status})`,
              { code: "kernel_runtime_run_not_running" }
            );
          }

          const objectHash = await putObject(tx, blob, now);
          const stagedResult = createStagedResult({
            objectHash,
            objectType,
            status,
            taskId,
            timestamp: now(),
            interruptPayload,
          });
          await tx.stagedResults.set(toStoredStagedResult(runId, stagedResult));
          return { objectHash, stagedResult };
        });
      },
    },

    store: {
      async get(hash) {
        return await backend.transact(async (tx) => {
          const object = await tx.objects.get(hash);
          return object === null ? null : object.bytes;
        });
      },

      async has(hash) {
        return await backend.transact(async (tx) => tx.objects.has(hash));
      },

      async put(blob, mediaType) {
        return await backend.transact(async (tx) =>
          putObject(tx, blob, now, mediaType)
        );
      },
    },

    thread: {
      async create(threadId, schemaId, initialBranchId) {
        return await backend.transact(async (tx) => {
          await assertThreadCreateIdsAvailable(tx, threadId, initialBranchId);
          const schema = await requireSchema(tx, schemaId);
          const rootTurnTreeHash = await createTurnTree(tx, {
            changes: createEmptyManifest(schema),
            now,
            schema,
          });
          const rootEventHash = await putObject(
            tx,
            encodeRecord({ threadId, type: "kernel_runtime_thread_bootstrap" }),
            now
          );
          const rootTurnNodeHash = await createTurnNode(tx, {
            consumedStagedResults: [],
            eventHash: rootEventHash,
            now,
            previousTurnNodeHash: null,
            schemaId,
            turnTreeHash: rootTurnTreeHash,
          });
          await tx.threads.put({
            createdAtMs: now(),
            rootTurnNodeHash,
            schemaId,
            threadId,
          });
          await tx.branches.set({
            branchId: initialBranchId,
            createdAtMs: now(),
            headTurnNodeHash: rootTurnNodeHash,
            threadId,
            updatedAtMs: now(),
          });
          return {
            branchId: initialBranchId,
            rootTurnNodeHash,
            rootTurnTreeHash,
            threadId,
          } satisfies ThreadCreateResult;
        });
      },

      async get(threadId) {
        return await backend.transact(async (tx) => {
          const thread = await tx.threads.get(threadId);
          return thread === null
            ? null
            : {
                rootTurnNodeHash: thread.rootTurnNodeHash,
                schemaId: thread.schemaId,
                threadId: thread.threadId,
              };
        });
      },

      async list(options) {
        if (!backend.capabilities()["thread.enumeration"]) {
          throw new TuvrenPersistenceError(
            "thread.list is not supported by this backend",
            { code: "kernel_capability_unsupported" }
          );
        }
        return await backend.transact(async (tx) => {
          if (tx.threads.list === undefined) {
            throw new TuvrenPersistenceError(
              "backend advertises thread.enumeration but does not implement ThreadRepository.list",
              { code: "kernel_capability_unsupported" }
            );
          }
          const decodedCursor =
            options?.cursor === undefined
              ? undefined
              : decodeCursor(options.cursor);
          const result = await tx.threads.list({
            limit: options?.limit,
            cursor: decodedCursor,
            filter: options?.filter,
          });
          return {
            threads: result.threads,
            nextCursor:
              result.nextCursor === undefined
                ? undefined
                : encodeCursor(result.nextCursor),
          };
        });
      },
    },

    tree: {
      async create(schemaId, changes, baseTurnTreeHash) {
        return await backend.transact(async (tx) => {
          const schema = await requireSchema(tx, schemaId);
          validateTurnTreeChangeSet(schema, changes);

          let baseManifest: TurnTreeManifest;

          if (baseTurnTreeHash === undefined) {
            // Base-less create: all schema paths must be provided
            for (const pathDef of schema.paths) {
              if (!Object.hasOwn(changes, pathDef.path)) {
                throw new TuvrenValidationError(
                  `path "${pathDef.path}" is required when creating a tree without a base`,
                  { code: "kernel_runtime_missing_required_tree_path" }
                );
              }
            }
            baseManifest = createEmptyManifest(schema);
          } else {
            const baseTree = await requireTurnTree(tx, baseTurnTreeHash);

            if (baseTree.schemaId !== schemaId) {
              throw new TuvrenValidationError(
                `base tree schema "${baseTree.schemaId}" does not match requested schema "${schemaId}"`,
                { code: "kernel_runtime_tree_schema_mismatch" }
              );
            }

            baseManifest = await requireTreeManifest(tx, baseTurnTreeHash);
          }

          return await createTurnTree(tx, {
            changes: { ...baseManifest, ...changes },
            now,
            schema,
          });
        });
      },

      async diff(treeHashA, treeHashB) {
        return await backend.transact(async (tx) => {
          const treeA = await requireTurnTree(tx, treeHashA);
          const treeB = await requireTurnTree(tx, treeHashB);

          if (treeA.schemaId !== treeB.schemaId) {
            throw new TuvrenValidationError(
              `cannot diff trees with different schemas: "${treeA.schemaId}" vs "${treeB.schemaId}"`,
              { code: "kernel_runtime_tree_schema_mismatch_diff" }
            );
          }

          const left = await requireTreeManifest(tx, treeHashA);
          const right = await requireTreeManifest(tx, treeHashB);
          return Object.keys({ ...left, ...right }).filter(
            (path) =>
              JSON.stringify(left[path] ?? null) !==
              JSON.stringify(right[path] ?? null)
          );
        });
      },

      async incorporate(baseTurnTreeHash, stagedResults) {
        return await backend.transact(async (tx) => {
          const baseTree = await requireTurnTree(tx, baseTurnTreeHash);
          const schema = await requireSchema(tx, baseTree.schemaId);

          // Reject unmatched staged object types (spec Appendix B)
          validateStagedResultsHaveRules(schema, stagedResults);

          const manifest = await requireTreeManifest(tx, baseTurnTreeHash);
          applyStagedResultsToManifest(schema, manifest, stagedResults);

          return await createTurnTree(tx, {
            changes: manifest,
            now,
            schema,
          });
        });
      },

      async manifest(treeHash) {
        return await backend.transact(async (tx) =>
          requireTreeManifest(tx, treeHash)
        );
      },

      async resolve(treeHash, path) {
        return await backend.transact(async (tx) => {
          const tree = await requireTurnTree(tx, treeHash);
          const schema = await requireSchema(tx, tree.schemaId);
          const isKnownPath = schema.paths.some((p) => p.path === path);

          if (!isKnownPath) {
            throw new TuvrenValidationError(
              `unknown path "${path}" in schema "${tree.schemaId}"`,
              { code: "kernel_runtime_unknown_tree_path" }
            );
          }

          const manifest = await requireTreeManifest(tx, treeHash);
          return manifest[path] ?? null;
        });
      },
    },

    turn: {
      async create(
        turnId,
        threadId,
        branchId,
        parentTurnId,
        startTurnNodeHash
      ) {
        return await backend.transact(async (tx) => {
          await assertTurnIdAvailable(tx, turnId);
          const thread = await requireThread(tx, threadId);
          const branch = await requireBranch(tx, branchId);

          if (branch.threadId !== threadId) {
            throw new TuvrenRuntimeError(
              "turn branch must belong to the requested thread",
              { code: "kernel_runtime_turn_thread_mismatch" }
            );
          }

          await requireThreadTurnNode(tx, startTurnNodeHash, thread);
          await validateTurnParent(
            tx,
            threadId,
            branchId,
            parentTurnId ?? null,
            startTurnNodeHash
          );

          const record: StoredTurn = {
            branchId,
            createdAtMs: now(),
            headTurnNodeHash: startTurnNodeHash,
            parentTurnId: parentTurnId ?? null,
            startTurnNodeHash,
            threadId,
            turnId,
            updatedAtMs: now(),
          };
          await tx.turns.set(record);
          return toTurnRecord(record);
        });
      },

      async get(turnId) {
        return await backend.transact(async (tx) => {
          const turn = await tx.turns.get(turnId);
          return turn === null ? null : toTurnRecord(turn);
        });
      },

      async updateHead(turnId, headTurnNodeHash) {
        await backend.transact(async (tx) => {
          const turn = await requireStoredTurn(tx, turnId);
          const thread = await requireThread(tx, turn.threadId);
          await requireThreadTurnNode(tx, headTurnNodeHash, thread);

          if (
            !(await turnNodeDescendsFrom(
              tx,
              headTurnNodeHash,
              turn.startTurnNodeHash
            ))
          ) {
            throw new TuvrenLineageError(
              `turn head "${headTurnNodeHash}" does not descend from start node "${turn.startTurnNodeHash}"`,
              { code: "kernel_runtime_turn_head_lineage_mismatch" }
            );
          }

          await assertTurnHeadRewritePreservesDependents(
            tx,
            toTurnRecord(turn),
            headTurnNodeHash
          );

          await tx.turns.set({
            ...turn,
            headTurnNodeHash,
            updatedAtMs: now(),
          });
        });
      },
    },

    verdicts: {
      compose(verdicts) {
        const abort = verdicts.find((verdict) => verdict.kind === "abort");
        if (abort !== undefined) {
          return Promise.resolve(abort);
        }

        const pause = verdicts.find((verdict) => verdict.kind === "pause");
        if (pause !== undefined) {
          return Promise.resolve(pause);
        }

        const modify = composeModifyVerdict(verdicts);
        if (modify !== undefined) {
          return Promise.resolve(modify);
        }

        return Promise.resolve(
          verdicts.find((verdict) => verdict.kind === "retry") ?? {
            kind: "proceed",
          }
        );
      },
    },
  };
}
