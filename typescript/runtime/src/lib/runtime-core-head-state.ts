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
  type HashString,
  TuvrenLineageError,
  TuvrenPersistenceError,
} from "@tuvren/core";
import {
  assertContextManifest,
  type ContextManifest,
} from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import {
  decodeDeterministicKernelRecord,
  type RuntimeKernel,
} from "@tuvren/kernel-protocol";
import { createEmptyContextManifest } from "./context-manifest.js";
import {
  decryptStoredMessage,
  type PayloadCodecBinding,
} from "./payload-codec-seam.js";
import type { HeadState } from "./runtime-core-loop.js";
import type { DurableRuntimeStatus } from "./runtime-core-recovery.js";
import { decodeKrakenMessageRecord } from "./runtime-core-recovery.js";
import {
  isTurnLineageRecord,
  toOptionalHash,
  toOrderedHashArray,
} from "./runtime-core-response.js";
import { isRecord } from "./runtime-core-shared.js";
import type { ExecutionSessionRequest } from "./runtime-execution-types.js";

/**
 * Load the full {@link HeadState} of a branch from the kernel.
 *
 * Resolves the branch's head turn node, reads the ordered `messages` path and
 * the `context.manifest` path from its turn tree, decodes (and decrypts) each
 * message payload, and falls back to an empty manifest when the tree carries
 * none.
 *
 * @throws TuvrenLineageError when the branch, its head turn node, a manifest,
 *   or a message record is missing.
 * @throws TuvrenPersistenceError with code `kernel_payload_erased` when a
 *   message payload was crypto-shredded and cannot be reconstructed.
 */
export async function loadHeadState(
  kernel: RuntimeKernel,
  payloadCodecBinding: PayloadCodecBinding,
  branchId: string
): Promise<HeadState> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new TuvrenLineageError(`branch "${branchId}" does not exist`, {
      code: "missing_branch",
    });
  }

  const turnNode = await kernel.node.get(branch.headTurnNodeHash);

  if (turnNode === null) {
    throw new TuvrenLineageError(
      `turn node "${branch.headTurnNodeHash}" does not exist`,
      {
        code: "missing_turn_node",
      }
    );
  }

  const messageHashes = toOrderedHashArray(
    await kernel.tree.resolve(turnNode.turnTreeHash, "messages")
  );
  const manifestHash = toOptionalHash(
    await kernel.tree.resolve(turnNode.turnTreeHash, "context.manifest")
  );
  const manifest =
    manifestHash === null
      ? createEmptyContextManifest()
      : await readManifest(kernel, manifestHash);

  return {
    branchHeadHash: branch.headTurnNodeHash,
    manifest,
    messageHashes,
    messages: await readMessages(kernel, payloadCodecBinding, messageHashes),
    turnNode,
  };
}

/**
 * Read the active agent name from the durable `runtime.status` record of a
 * turn tree, or `undefined` when no valid status (or agent name) is recorded.
 */
export async function readRecoveredActiveAgentName(
  kernel: RuntimeKernel,
  turnTreeHash: HashString
): Promise<string | undefined> {
  return (await readRecoveredRuntimeStatus(kernel, turnTreeHash))?.activeAgent;
}

/**
 * Read and validate the durable `runtime.status` record from a turn tree.
 *
 * Tolerant by design: a missing path, missing payload, or a record whose
 * `state` is not one of `completed`/`failed`/`paused`/`running` yields
 * `undefined` rather than an error, because recovery must cope with turns
 * that never wrote a status. Optional fields (`activeAgent`, `partial`,
 * `pauseReason`) are only carried through when they have the expected type.
 */
export async function readRecoveredRuntimeStatus(
  kernel: RuntimeKernel,
  turnTreeHash: HashString
): Promise<DurableRuntimeStatus | undefined> {
  const runtimeStatusHash = toOptionalHash(
    await kernel.tree.resolve(turnTreeHash, "runtime.status")
  );

  if (runtimeStatusHash === null) {
    return undefined;
  }

  const payload = await kernel.store.get(runtimeStatusHash);

  if (payload === null) {
    return undefined;
  }

  const runtimeStatus = decodeDeterministicKernelRecord(payload);

  if (
    !isRecord(runtimeStatus) ||
    typeof runtimeStatus.state !== "string" ||
    (runtimeStatus.state !== "completed" &&
      runtimeStatus.state !== "failed" &&
      runtimeStatus.state !== "paused" &&
      runtimeStatus.state !== "running")
  ) {
    return undefined;
  }

  return {
    ...(typeof runtimeStatus.activeAgent === "string"
      ? { activeAgent: runtimeStatus.activeAgent }
      : {}),
    ...(typeof runtimeStatus.partial === "boolean"
      ? { partial: runtimeStatus.partial }
      : {}),
    ...(typeof runtimeStatus.pauseReason === "string"
      ? { pauseReason: runtimeStatus.pauseReason }
      : {}),
    state: runtimeStatus.state,
  };
}

/**
 * Resolve the turn-tree schema id an execution should run under.
 *
 * An explicit `request.schemaId` wins; otherwise the thread's recorded schema
 * id is used when the thread exists. Either way the result is passed through
 * `ensureSchemaId`, which is responsible for defaulting and registering the
 * schema.
 */
export async function resolveExecutionSchemaId(
  kernel: RuntimeKernel,
  ensureSchemaId: (schemaId?: string) => Promise<string>,
  request: ExecutionSessionRequest
): Promise<string> {
  if (request.schemaId !== undefined) {
    return await ensureSchemaId(request.schemaId);
  }

  const thread = await kernel.thread.get(request.threadId);
  return await ensureSchemaId(thread?.schemaId);
}

/**
 * Resolve and validate the parent turn id for a new turn on a branch.
 *
 * Precedence: an explicit parent turn id from the request (including an
 * explicit `null`), then the optional configured resolver, then the branch's
 * active turn id read from the head turn tree's `turn.lineage` record. The
 * result is always validated against the branch's actual active turn.
 *
 * @param resolveConfiguredParentTurnId - Optional host-configured resolver
 *   consulted only when the request left the parent turn id `undefined`.
 * @param explicitParentTurnId - Parent turn id from the request; `null`
 *   explicitly requests a root turn, `undefined` defers to resolution.
 * @returns The validated parent turn id, or `null` for a root turn.
 * @throws TuvrenLineageError with code `invalid_parent_turn` when the
 *   resolved parent is not the branch's active turn, does not exist, or
 *   belongs to a different thread.
 */
export async function resolveParentTurnId(
  kernel: RuntimeKernel,
  resolveConfiguredParentTurnId:
    | ((
        threadId: string,
        branchId: string
      ) => Promise<string | null> | string | null)
    | undefined,
  threadId: string,
  branchId: string,
  explicitParentTurnId?: string | null
): Promise<string | null> {
  const resolvedParentTurnId =
    explicitParentTurnId === undefined
      ? await resolveConfiguredParentTurnId?.(threadId, branchId)
      : explicitParentTurnId;

  const parentTurnId =
    resolvedParentTurnId === undefined
      ? await readBranchActiveTurnId(kernel, branchId)
      : resolvedParentTurnId;
  await assertValidParentTurnId(kernel, threadId, branchId, parentTurnId);
  return parentTurnId;
}

/**
 * Assert that `parentTurnId` matches the branch's active turn, exists in the
 * kernel, and stays on the expected thread; throws `TuvrenLineageError`
 * (`invalid_parent_turn`) otherwise.
 */
async function assertValidParentTurnId(
  kernel: RuntimeKernel,
  threadId: string,
  branchId: string,
  parentTurnId: string | null
): Promise<void> {
  const expectedParentTurnId = await readBranchActiveTurnId(kernel, branchId);

  if (parentTurnId !== expectedParentTurnId) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" is not the active branch parent for branch "${branchId}"`,
      {
        code: "invalid_parent_turn",
        details: {
          branchId,
          expectedParentTurnId,
          parentTurnId,
          threadId,
        },
      }
    );
  }

  if (parentTurnId === null) {
    return;
  }

  const parentTurn = await kernel.turn.get(parentTurnId);

  if (parentTurn === null) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" does not exist`,
      {
        code: "invalid_parent_turn",
        details: {
          branchId,
          parentTurnId,
          threadId,
        },
      }
    );
  }

  if (parentTurn.threadId !== threadId) {
    throw new TuvrenLineageError(
      `parent turn "${parentTurnId}" must stay on thread "${threadId}"`,
      {
        code: "invalid_parent_turn",
        details: {
          branchId,
          parentThreadId: parentTurn.threadId,
          parentTurnId,
          threadId,
        },
      }
    );
  }
}

async function readManifest(
  kernel: RuntimeKernel,
  hash: HashString
): Promise<ContextManifest> {
  const payload = await kernel.store.get(hash);

  if (payload === null) {
    throw new TuvrenLineageError(`manifest "${hash}" does not exist`, {
      code: "missing_manifest",
      details: {
        hash,
      },
    });
  }

  const manifest = decodeDeterministicKernelRecord(payload);
  assertContextManifest(manifest, `manifest "${hash}"`);
  return manifest;
}

async function readMessages(
  kernel: RuntimeKernel,
  payloadCodecBinding: PayloadCodecBinding,
  hashes: HashString[]
): Promise<TuvrenMessage[]> {
  const messages: TuvrenMessage[] = [];

  for (const hash of hashes) {
    messages.push(await readMessage(kernel, payloadCodecBinding, hash));
  }

  return messages;
}

async function readMessage(
  kernel: RuntimeKernel,
  payloadCodecBinding: PayloadCodecBinding,
  hash: HashString
): Promise<TuvrenMessage> {
  const payload = await kernel.store.get(hash);

  if (payload === null) {
    throw new TuvrenLineageError(`message "${hash}" does not exist`, {
      code: "missing_message",
      details: {
        hash,
      },
    });
  }

  // Crypto-shredding seam (KRT-BF005): decrypt before decoding. An erased
  // payload on the execution path is a controlled, typed failure — a shredded
  // conversation cannot be reconstructed to feed the model — not a raw crash.
  const decrypted = await decryptStoredMessage(payloadCodecBinding, payload);
  if (decrypted.status === "erased") {
    throw new TuvrenPersistenceError(
      `message "${hash}" payload was erased (key "${decrypted.keyRef}" destroyed) and cannot be reconstructed for execution`,
      {
        code: "kernel_payload_erased",
        details: { hash, keyRef: decrypted.keyRef },
      }
    );
  }

  return decodeKrakenMessageRecord(decrypted.plaintext, `message "${hash}"`);
}

async function readBranchHeadState(
  kernel: RuntimeKernel,
  branchId: string
): Promise<{
  branchHeadHash: HashString;
  turnNode: Exclude<Awaited<ReturnType<RuntimeKernel["node"]["get"]>>, null>;
}> {
  const branch = await kernel.branch.get(branchId);

  if (branch === null) {
    throw new TuvrenLineageError(`branch "${branchId}" does not exist`, {
      code: "missing_branch",
    });
  }

  const turnNode = await kernel.node.get(branch.headTurnNodeHash);

  if (turnNode === null) {
    throw new TuvrenLineageError(
      `turn node "${branch.headTurnNodeHash}" does not exist`,
      {
        code: "missing_turn_node",
      }
    );
  }

  return {
    branchHeadHash: branch.headTurnNodeHash,
    turnNode,
  };
}

/**
 * Read the branch's active turn id from the `turn.lineage` record on its head
 * turn tree; `null` when the branch has no lineage yet (no turn created).
 */
async function readBranchActiveTurnId(
  kernel: RuntimeKernel,
  branchId: string
): Promise<string | null> {
  const { turnNode } = await readBranchHeadState(kernel, branchId);
  const lineageHash = toOptionalHash(
    await kernel.tree.resolve(turnNode.turnTreeHash, "turn.lineage")
  );

  if (lineageHash === null) {
    return null;
  }

  const payload = await kernel.store.get(lineageHash);

  if (payload === null) {
    throw new TuvrenLineageError(
      `turn lineage "${lineageHash}" does not exist`,
      {
        code: "missing_turn_lineage",
        details: {
          branchId,
          hash: lineageHash,
        },
      }
    );
  }

  const decoded = decodeDeterministicKernelRecord(payload);

  if (isTurnLineageRecord(decoded)) {
    return decoded.activeTurnId;
  }

  throw new TuvrenLineageError(
    `branch "${branchId}" turn lineage must carry an activeTurnId`,
    {
      code: "invalid_turn_lineage",
      details: {
        branchId,
        lineageHash,
        turnLineage: decoded,
      },
    }
  );
}
