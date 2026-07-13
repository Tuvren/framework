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

import type { HashString, KernelRecord } from "@tuvren/core";
import type { ContextManifest } from "@tuvren/core/execution";
import type { TuvrenMessage } from "@tuvren/core/messages";
import type { LoopState } from "./runtime-core-loop.js";
import type { DurableRuntimeStatus } from "./runtime-core-recovery.js";
import type { TurnLineageRecord } from "./runtime-core-response.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/**
 * Warning payload emitted once per extension when its serialized manifest
 * state exceeds the configured budget.
 */
interface ManifestExtensionStateWarning {
  activeAgent: string;
  budgetBytes: number;
  code: "manifest_extension_state_budget_exceeded";
  extensionName: string;
  observedBytes: number;
  runId: string;
  threadId: string;
  turnId: string;
}

/**
 * Host seam for staging and storing kernel records.
 *
 * Provides deterministic record encoding, the message-encryption codec, the
 * run-scoped staging and content-addressed store primitives, and the
 * manifest extension-state warning configuration used by the staging
 * helpers in this module.
 */
export interface RuntimeCorePersistenceHost {
  /** Emit a manifest extension-state budget warning to the host. */
  emitWarning(warning: ManifestExtensionStateWarning): void;
  /**
   * Deterministically encode a value as a kernel record; `label` is used in
   * encoding diagnostics.
   */
  encodeKernelRecord(value: unknown, label: string): Uint8Array;
  /**
   * Crypto-shredding seam (KRT-BF005): encrypt an encoded message record under
   * the host payload codec before it is staged. The default identity codec
   * returns the bytes unchanged, so no-codec hosts stage plaintext as before.
   */
  encryptMessageRecord(record: Uint8Array): Promise<Uint8Array>;
  /**
   * Per-extension serialized-size budget in bytes for manifest extension
   * state, or `false` when the warning is disabled.
   */
  getManifestExtensionStateWarningBudgetBytes(): false | number;
  /**
   * Set of extension names already warned for this execution handle, used to
   * emit each budget warning at most once per extension.
   */
  getOrCreateManifestExtensionStateWarningKeys(
    handle: RuntimeExecutionHandle
  ): Set<string>;
  /** Stage an encoded record into the given run and return its hash. */
  stageRecord(
    runId: string,
    record: Uint8Array,
    taskId: string,
    objectType: string
  ): Promise<HashString>;
  /** Store an encoded record content-addressed and return its hash. */
  storeRecord(record: Uint8Array): Promise<HashString>;
}

/**
 * Stage a context manifest record for the run.
 *
 * When `warningContext` is provided, each extension's manifest state is
 * checked against the host's byte budget first and a
 * `manifest_extension_state_budget_exceeded` warning is emitted once per
 * extension per execution.
 *
 * @returns Hash of the staged manifest record.
 */
export async function stageManifest(
  host: RuntimeCorePersistenceHost,
  runId: string,
  manifest: ContextManifest,
  warningContext?: {
    handle: RuntimeExecutionHandle;
    loopState: LoopState;
  }
): Promise<HashString> {
  if (warningContext !== undefined) {
    warnManifestExtensionStateBudgetIfNeeded(
      host,
      warningContext.handle,
      warningContext.loopState,
      runId,
      manifest
    );
  }

  return await host.stageRecord(
    runId,
    host.encodeKernelRecord(manifest, "manifest"),
    "manifest",
    "context_manifest"
  );
}

/**
 * Stage a message record for the run, encrypting the encoded bytes through
 * the host payload codec first (crypto-shredding seam, KRT-BF005; the
 * default identity codec stages plaintext).
 *
 * @returns Hash of the staged message record.
 */
export async function stageMessage(
  host: RuntimeCorePersistenceHost,
  runId: string,
  message: TuvrenMessage,
  taskId: string
): Promise<HashString> {
  return await host.stageRecord(
    runId,
    await host.encryptMessageRecord(
      host.encodeKernelRecord(message, "message")
    ),
    taskId,
    "message"
  );
}

/**
 * Stage a turn-lineage record marking `turnId` as the active turn.
 *
 * @returns Hash of the staged turn-lineage record.
 */
export async function stageTurnLineage(
  host: RuntimeCorePersistenceHost,
  runId: string,
  turnId: string,
  taskId: string
): Promise<HashString> {
  return await host.stageRecord(
    runId,
    host.encodeKernelRecord(
      {
        activeTurnId: turnId,
      } satisfies TurnLineageRecord,
      "turn lineage"
    ),
    taskId,
    "turn_lineage"
  );
}

/**
 * Stage a durable runtime-status record, dropping `undefined` fields so the
 * encoded record stays deterministic.
 *
 * @returns Hash of the staged runtime-status record.
 */
export async function stageRuntimeStatus(
  host: RuntimeCorePersistenceHost,
  runId: string,
  status: DurableRuntimeStatus,
  taskId: string
): Promise<HashString> {
  const serializedStatus = Object.fromEntries(
    Object.entries(status).filter(([, value]) => value !== undefined)
  );
  return await host.stageRecord(
    runId,
    host.encodeKernelRecord(serializedStatus, "runtime status"),
    taskId,
    "runtime_status"
  );
}

/**
 * Encode and store an arbitrary value as a content-addressed kernel record
 * (unstaged, not tied to a run).
 *
 * @returns Hash of the stored record.
 */
export async function storeKernelRecord(
  host: RuntimeCorePersistenceHost,
  value: unknown,
  label: string
): Promise<HashString> {
  return await host.storeRecord(host.encodeKernelRecord(value, label));
}

/**
 * Store an event record content-addressed under the `"event"` label.
 *
 * @returns Hash of the stored event record.
 */
export async function storeEventRecord(
  host: RuntimeCorePersistenceHost,
  event: KernelRecord
): Promise<HashString> {
  return await storeKernelRecord(host, event, "event");
}

/**
 * Emit a budget warning for each manifest extension whose approximate
 * serialized size exceeds the host budget, at most once per extension per
 * execution handle.
 */
function warnManifestExtensionStateBudgetIfNeeded(
  host: RuntimeCorePersistenceHost,
  handle: RuntimeExecutionHandle,
  loopState: LoopState,
  runId: string,
  manifest: ContextManifest
): void {
  const budget = host.getManifestExtensionStateWarningBudgetBytes();

  if (budget === false) {
    return;
  }

  const extensionEntries = Object.entries(manifest.extensions);

  if (extensionEntries.length === 0) {
    return;
  }

  const warningKeys = host.getOrCreateManifestExtensionStateWarningKeys(handle);

  for (const [extensionName, extensionState] of extensionEntries) {
    if (warningKeys.has(extensionName)) {
      continue;
    }

    const observedBytes = approximateSerializedByteLength(extensionState);

    if (observedBytes === undefined || observedBytes <= budget) {
      continue;
    }

    warningKeys.add(extensionName);
    host.emitWarning({
      activeAgent: loopState.activeConfig.name,
      budgetBytes: budget,
      code: "manifest_extension_state_budget_exceeded",
      extensionName,
      observedBytes,
      runId,
      threadId: handle.request.threadId,
      turnId: handle.turnId,
    });
  }
}

/**
 * Approximate a value's serialized size as UTF-8 JSON bytes; returns
 * `undefined` for values that cannot be JSON-serialized.
 */
function approximateSerializedByteLength(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}
