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

import { selectKernelMutant } from "@tuvren/kernel-testkit";
import type { SelectedKernelMutant } from "@tuvren/kernel-testkit";

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
import { createProjection } from "./host-scenario-support.js";
import { result } from "./host-support.js";
import { createSyscallBindings } from "./host-syscalls.js";

const MUTANT_ENV = "TUVREN_KERNEL_MUTANT";
const MUTANT_ACTIVATION_OPERATION = "kernel.mutant.activation";
const STORAGE_KIND = {
  memory: "none",
  postgres: "postgres-database",
  sqlite: "sqlite-directory",
} as const;

const defaultCapabilities = (
  backend: KernelAdapterConfig["backend"]
): readonly string[] => {
  if (backend === "postgres") {
    return [
      "kernel.fault-injection",
      "kernel.syscall",
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.edge-validation.composite",
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
      "kernel.fault-injection",
      "kernel.syscall",
      "kernel.protocol",
      "kernel.edge-validation",
      "kernel.edge-validation.composite",
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
    "kernel.fault-injection",
    "kernel.syscall",
    "kernel.protocol",
    "kernel.edge-validation",
    "kernel.edge-validation.composite",
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
  let mutantId: string | undefined;

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

    if (arg === "--mutant") {
      mutantId = args[index + 1];
      if (mutantId === undefined) {
        throw new Error("--mutant requires a value");
      }
      index += 1;
      continue;
    }

    if (arg === "--mutant-from-env") {
      mutantId = process.env[MUTANT_ENV];
      if (mutantId === undefined || mutantId.length === 0) {
        throw new Error(`--mutant-from-env requires ${MUTANT_ENV}`);
      }
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
    ...(mutantId === undefined ? {} : { mutant: selectKernelMutant(mutantId) }),
  });
};

const createMutantActivationOperation =
  (mutant: SelectedKernelMutant): KernelOperation =>
  () =>
    createProjection({ activation: mutant.readActivation() });

const ADAPTER_CONFIG = readAdapterConfig(process.argv.slice(2));

let notificationSink:
  | ((
      method: "faultReached",
      params: { token: string; processEpoch: number; phase: string }
    ) => Promise<void>)
  | undefined;
const syscallBindings = createSyscallBindings(
  ADAPTER_CONFIG,
  async (receipt) => {
    const epoch = Number(process.env.TUVREN_CONFORMANCE_PROCESS_EPOCH);
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 1 ||
      notificationSink === undefined
    ) {
      throw new Error(
        "supervisor process epoch and notification transport are required for blocking faults"
      );
    }
    await notificationSink("faultReached", { ...receipt, processEpoch: epoch });
  }
);

const createKernelOperations = (
  config: KernelAdapterConfig
): Map<string, KernelOperation> => {
  const protocolLogicalScenarios = createProtocolLogicalScenarios(config);
  const reclamationScenarios = createReclamationScenarios(config);
  const restartRecoveryScenarios = createRestartRecoveryScenarios(config);
  const runLivenessScenarios = createRunLivenessScenarios(config);

  return new Map<string, KernelOperation>(
    Object.entries({
      "kernel.lineage.cross-thread-rejection":
        protocolLogicalScenarios.runCrossThreadLineage,
      "kernel.logical.branch-list": protocolLogicalScenarios.runBranchList,
      "kernel.logical.diff-paths": protocolLogicalScenarios.runLogicalDiff,
      "kernel.logical.recovery-state":
        protocolLogicalScenarios.runRecoveryState,
      "kernel.logical.thread-list": protocolLogicalScenarios.runThreadList,
      "kernel.protocol.canonical-rejection": (input) =>
        protocolLogicalScenarios.runCanonicalRejection(
          protocolLogicalScenarios.readProtocolFixture(input)
        ),
      "kernel.protocol.deterministic-hashing":
        protocolLogicalScenarios.deterministicHashing,
      "kernel.protocol.edge-validation":
        protocolLogicalScenarios.runProtocolEdgeValidation,
      "kernel.protocol.modify-composition":
        protocolLogicalScenarios.runModifyComposition,
      "kernel.protocol.schema-roundtrip": (input) =>
        protocolLogicalScenarios.schemaRoundtrip(
          protocolLogicalScenarios.readProtocolFixture(input)
        ),
      "kernel.reclamation.erasure-probe": reclamationScenarios.runErasureProbe,
      "kernel.reclamation.reclaim-probe":
        reclamationScenarios.runReclamationProbe,
      "kernel.restart-recovery.close-reopen-checkpoint":
        restartRecoveryScenarios.runRestartRecovery,
      "kernel.restart-recovery.concurrent-writer":
        restartRecoveryScenarios.runConcurrentWriterConflict,
      "kernel.restart-recovery.crash-recovery-durable":
        restartRecoveryScenarios.runDurableCrashRecovery,
      "kernel.restart-recovery.crash-recovery-in-process":
        restartRecoveryScenarios.runInProcessCrashRecovery,
      "kernel.run-liveness.clock-skew-preemption":
        runLivenessScenarios.runClockSkewPreemption,
      "kernel.run-liveness.expired-listing":
        runLivenessScenarios.runExpiredListing,
      "kernel.run-liveness.lease-renewal": runLivenessScenarios.runLeaseRenewal,
      "kernel.run-liveness.stale-preemption":
        runLivenessScenarios.runStalePreemption,
      "kernel.scope-isolation.cross-scope-probe":
        reclamationScenarios.runCrossScopeProbe,
      ...(config.mutant === undefined
        ? {}
        : {
            [MUTANT_ACTIVATION_OPERATION]: createMutantActivationOperation(
              config.mutant
            ),
          }),
    } satisfies Record<string, KernelOperation>)
  );
};

const initialize = (
  packetId: string,
  planVersion: string
): AdapterCapabilities => ({
  adapterId: ADAPTER_CONFIG.adapterId,
  capabilities: ADAPTER_CONFIG.capabilities,
  packetId,
  planVersion,
  profiles:
    ADAPTER_CONFIG.backend === "memory" && ADAPTER_CONFIG.mutant === undefined
      ? ["kernel.memory"]
      : [],
  protocolVersion: "0.2.0",
  storageKinds: [STORAGE_KIND[ADAPTER_CONFIG.backend]],
});

const dispatch = async (
  operation: string,
  input: unknown,
  _controls: AdapterControls,
  instance?: unknown
): Promise<OperationOutcome> => {
  if (syscallBindings.has(operation)) {
    return await syscallBindings.dispatch(operation, input, instance);
  }
  const operationHandler = createKernelOperations(
    syscallBindings.instanceConfig(instance)
  ).get(operation);
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
  armFault: async (params) =>
    await syscallBindings.protocolControl("armFault", params),
  awaitOperation: syscallBindings.awaitOperation,
  cancelOperation: syscallBindings.cancelOperation,
  createInstance: syscallBindings.createInstance,
  destroyInstance: syscallBindings.destroyInstance,
  dispatch,
  initialize,
  isLosslessRequest: (method, params) =>
    method === "awaitOperation" ||
    (typeof params === "object" &&
      params !== null &&
      "operation" in params &&
      typeof params.operation === "string" &&
      syscallBindings.has(params.operation)),
  openInstance: syscallBindings.openInstance,
  setNotificationSink: (sink) => {
    notificationSink = sink;
  },
  shutdown: syscallBindings.shutdown,
  startOperation: syscallBindings.startOperation,
} satisfies StdioConformanceAdapter);
