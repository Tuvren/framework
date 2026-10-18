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

import type { RuntimeKernel } from "@tuvren/kernel-protocol";

import { encryptMessageRecord } from "./payload-codec-seam.js";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import type { RuntimeCorePersistenceHost } from "./runtime-core-persistence.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";

/** Dependencies for {@link buildRuntimeCorePersistenceHost}. */
interface PersistenceHostDependencies {
  emitWarning: (warning: {
    activeAgent: string;
    budgetBytes: number;
    code: "manifest_extension_state_budget_exceeded";
    extensionName: string;
    observedBytes: number;
    runId: string;
    threadId: string;
    turnId: string;
  }) => void;
  encodeKernelRecord: (value: unknown, label: string) => Uint8Array;
  getManifestExtensionStateWarningBudgetBytes: () => false | number;
  getOrCreateManifestExtensionStateWarningKeys: (
    handle: RuntimeExecutionHandle
  ) => Set<string>;
  kernel: RuntimeKernel;
  payloadCodecBinding: PayloadCodecBinding;
}

/**
 * Builds the host seam for the persistence module
 * (`runtime-core-persistence.ts`): kernel record encoding, the
 * crypto-shredding message-encryption seam, manifest extension-state budget
 * warnings, and the kernel `staging.stage` / `store.put` writes.
 */
export const buildRuntimeCorePersistenceHost = (
  dependencies: PersistenceHostDependencies
): RuntimeCorePersistenceHost => ({
  emitWarning: (warning) => {
    dependencies.emitWarning(warning);
  },
  encodeKernelRecord: (value, label) =>
    dependencies.encodeKernelRecord(value, label),
  encryptMessageRecord: async (record) =>
    await encryptMessageRecord(dependencies.payloadCodecBinding, record),
  getManifestExtensionStateWarningBudgetBytes: () =>
    dependencies.getManifestExtensionStateWarningBudgetBytes(),
  getOrCreateManifestExtensionStateWarningKeys: (handle) =>
    dependencies.getOrCreateManifestExtensionStateWarningKeys(handle),
  stageRecord: async (runId, record, taskId, objectType) => {
    const stageResult = await dependencies.kernel.staging.stage(
      runId,
      record,
      taskId,
      objectType,
      "completed"
    );
    return stageResult.objectHash;
  },
  storeRecord: async (record) => await dependencies.kernel.store.put(record),
});
