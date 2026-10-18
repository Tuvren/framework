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

import type {
  AdapterCapabilities,
  AdapterControls,
  OperationOutcome,
} from "../../../../tools/conformance/adapter-protocol/index.js";
import { createAdapterErrorEnvelope } from "../../../../tools/conformance/adapter-protocol/index.js";
import type { StdioConformanceAdapter } from "../../../../tools/conformance/adapter-protocol/stdio-host.js";
import { serveStdioAdapter } from "../../../../tools/conformance/adapter-protocol/stdio-host.js";
import { createProtocolLogicalScenarios } from "./host-protocol-logical-scenarios.js";
import { createReclamationScenarios } from "./host-reclamation-scenarios.js";
import { createRestartRecoveryScenarios } from "./host-restart-recovery-scenarios.js";
import { createRunLivenessScenarios } from "./host-run-liveness-scenarios.js";
import type {
  KernelAdapterConfig,
  KernelOperation,
} from "./host-scenario-support.js";
import { result } from "./host-support.js";

const defaultCapabilities = (
  backend: KernelAdapterConfig["backend"]
): readonly string[] => {
  if (backend === "postgres") {
    return [
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.logical",
      "kernel.run-liveness",
      // Shared multi-owner rendezvous: PostgreSQL is the only backend that
      // advertises an authoritative shared lease clock (ADR-0050, BackendCapability
      // shared-lease-clock). The clock-skew preemption check is gated on this
      // capability so it runs only where backend-time lease judgment applies;
      // single-writer embedded backends keep the in-process clock and are excluded.
      "kernel.shared-lease-clock",
      "kernel.persistence.durable",
      "kernel.restart-recovery",
      "kernel.scope-isolation",
      "kernel.reclamation",
      "kernel-protocol.thread.enumeration",
    ];
  }

  if (backend === "sqlite") {
    return [
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.logical",
      "kernel.run-liveness",
      "kernel.persistence.durable",
      "kernel.restart-recovery",
      "kernel.scope-isolation",
      "kernel.reclamation",
      "kernel-protocol.thread.enumeration",
    ];
  }

  return [
    "kernel.protocol",
    "kernel.edge-validation",
    "kernel.logical",
    "kernel.run-liveness",
    "kernel.restart-recovery",
    "kernel.scope-isolation",
    "kernel.reclamation",
    "kernel-protocol.thread.enumeration",
  ];
};

const readAdapterConfig = (args: readonly string[]): KernelAdapterConfig => {
  const capabilities: string[] = [];
  let adapterId = "typescript-kernel-memory";
  let backend: KernelAdapterConfig["backend"] = "memory";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--adapter-id") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--adapter-id requires a value");
      }
      adapterId = value;
      index += 1;
      continue;
    }

    if (arg === "--backend") {
      const value = args[index + 1];
      if (value !== "memory" && value !== "postgres" && value !== "sqlite") {
        throw new Error("--backend must be memory, postgres, or sqlite");
      }
      backend = value;
      index += 1;
      continue;
    }

    if (arg === "--capability") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--capability requires a value");
      }
      capabilities.push(value);
      index += 1;
    }
  }

  return Object.freeze({
    adapterId,
    backend,
    capabilities: Object.freeze(
      capabilities.length > 0 ? capabilities : defaultCapabilities(backend)
    ),
  });
};

const ADAPTER_CONFIG = readAdapterConfig(process.argv.slice(2));

const protocolLogicalScenarios = createProtocolLogicalScenarios(ADAPTER_CONFIG);
const reclamationScenarios = createReclamationScenarios(ADAPTER_CONFIG);
const restartRecoveryScenarios = createRestartRecoveryScenarios(ADAPTER_CONFIG);
const runLivenessScenarios = createRunLivenessScenarios(ADAPTER_CONFIG);

const kernelOperations = new Map<string, KernelOperation>([
  [
    "kernel.protocol.deterministic-hashing",
    protocolLogicalScenarios.deterministicHashing,
  ],
  [
    "kernel.protocol.schema-roundtrip",
    (input) =>
      protocolLogicalScenarios.schemaRoundtrip(
        protocolLogicalScenarios.readProtocolFixture(input)
      ),
  ],
  [
    "kernel.protocol.modify-composition",
    protocolLogicalScenarios.runModifyComposition,
  ],
  [
    "kernel.protocol.canonical-rejection",
    (input) =>
      protocolLogicalScenarios.runCanonicalRejection(
        protocolLogicalScenarios.readProtocolFixture(input)
      ),
  ],
  [
    "kernel.protocol.edge-validation",
    protocolLogicalScenarios.runProtocolEdgeValidation,
  ],
  ["kernel.logical.diff-paths", protocolLogicalScenarios.runLogicalDiff],
  ["kernel.logical.branch-list", protocolLogicalScenarios.runBranchList],
  ["kernel.logical.recovery-state", protocolLogicalScenarios.runRecoveryState],
  ["kernel.logical.thread-list", protocolLogicalScenarios.runThreadList],
  [
    "kernel.lineage.cross-thread-rejection",
    protocolLogicalScenarios.runCrossThreadLineage,
  ],
  ["kernel.run-liveness.lease-renewal", runLivenessScenarios.runLeaseRenewal],
  [
    "kernel.run-liveness.expired-listing",
    runLivenessScenarios.runExpiredListing,
  ],
  [
    "kernel.run-liveness.stale-preemption",
    runLivenessScenarios.runStalePreemption,
  ],
  [
    "kernel.run-liveness.clock-skew-preemption",
    runLivenessScenarios.runClockSkewPreemption,
  ],
  [
    "kernel.restart-recovery.close-reopen-checkpoint",
    restartRecoveryScenarios.runRestartRecovery,
  ],
  [
    "kernel.restart-recovery.crash-recovery-durable",
    restartRecoveryScenarios.runDurableCrashRecovery,
  ],
  [
    "kernel.restart-recovery.crash-recovery-in-process",
    restartRecoveryScenarios.runInProcessCrashRecovery,
  ],
  [
    "kernel.restart-recovery.concurrent-writer",
    restartRecoveryScenarios.runConcurrentWriterConflict,
  ],
  [
    "kernel.scope-isolation.cross-scope-probe",
    reclamationScenarios.runCrossScopeProbe,
  ],
  [
    "kernel.reclamation.reclaim-probe",
    reclamationScenarios.runReclamationProbe,
  ],
  ["kernel.reclamation.erasure-probe", reclamationScenarios.runErasureProbe],
]);

const initialize = (
  packetId: string,
  planVersion: string
): AdapterCapabilities => ({
  adapterId: ADAPTER_CONFIG.adapterId,
  capabilities: ADAPTER_CONFIG.capabilities,
  packetId,
  planVersion,
});

const dispatch = async (
  operation: string,
  input: unknown,
  _controls: AdapterControls
): Promise<OperationOutcome> => {
  const operationHandler = kernelOperations.get(operation);
  if (operationHandler === undefined) {
    return {
      error: {
        code: "adapter_operation_not_implemented",
        message: `${ADAPTER_CONFIG.adapterId} does not implement ${operation}`,
      },
      kind: "error",
    };
  }

  try {
    const operationResult = await operationHandler(input);
    return result(operationResult);
  } catch (error: unknown) {
    return {
      error: createAdapterErrorEnvelope(error),
      kind: "error",
    };
  }
};

await serveStdioAdapter({
  dispatch,
  initialize,
} satisfies StdioConformanceAdapter);
