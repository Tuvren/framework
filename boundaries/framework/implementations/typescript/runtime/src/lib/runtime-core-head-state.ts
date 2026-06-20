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
  type RuntimeKernel as KrakenKernel,
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

export async function loadHeadState(
  kernel: KrakenKernel,
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

export async function readRecoveredActiveAgentName(
  kernel: KrakenKernel,
  turnTreeHash: HashString
): Promise<string | undefined> {
  return (await readRecoveredRuntimeStatus(kernel, turnTreeHash))?.activeAgent;
}

export async function readRecoveredRuntimeStatus(
  kernel: KrakenKernel,
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

export async function resolveExecutionSchemaId(
  kernel: KrakenKernel,
  ensureSchemaId: (schemaId?: string) => Promise<string>,
  request: ExecutionSessionRequest
): Promise<string> {
  if (request.schemaId !== undefined) {
    return await ensureSchemaId(request.schemaId);
  }

  const thread = await kernel.thread.get(request.threadId);
  return await ensureSchemaId(thread?.schemaId);
}

export async function resolveParentTurnId(
  kernel: KrakenKernel,
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

async function assertValidParentTurnId(
  kernel: KrakenKernel,
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
  kernel: KrakenKernel,
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
  kernel: KrakenKernel,
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
  kernel: KrakenKernel,
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
  kernel: KrakenKernel,
  branchId: string
): Promise<{
  branchHeadHash: HashString;
  turnNode: Exclude<Awaited<ReturnType<KrakenKernel["node"]["get"]>>, null>;
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

async function readBranchActiveTurnId(
  kernel: KrakenKernel,
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
