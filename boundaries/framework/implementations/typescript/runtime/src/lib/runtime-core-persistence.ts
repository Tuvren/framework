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

export interface RuntimeCorePersistenceHost {
  emitWarning(warning: ManifestExtensionStateWarning): void;
  encodeKernelRecord(value: unknown, label: string): Uint8Array;
  /**
   * Crypto-shredding seam (KRT-BF005): encrypt an encoded message record under
   * the host payload codec before it is staged. The default identity codec
   * returns the bytes unchanged, so no-codec hosts stage plaintext as before.
   */
  encryptMessageRecord(record: Uint8Array): Promise<Uint8Array>;
  getManifestExtensionStateWarningBudgetBytes(): false | number;
  getOrCreateManifestExtensionStateWarningKeys(
    handle: RuntimeExecutionHandle
  ): Set<string>;
  stageRecord(
    runId: string,
    record: Uint8Array,
    taskId: string,
    objectType: string
  ): Promise<HashString>;
  storeRecord(record: Uint8Array): Promise<HashString>;
}

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

export async function storeKernelRecord(
  host: RuntimeCorePersistenceHost,
  value: unknown,
  label: string
): Promise<HashString> {
  return await host.storeRecord(host.encodeKernelRecord(value, label));
}

export async function storeEventRecord(
  host: RuntimeCorePersistenceHost,
  event: KernelRecord
): Promise<HashString> {
  return await storeKernelRecord(host, event, "event");
}

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

function approximateSerializedByteLength(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}
