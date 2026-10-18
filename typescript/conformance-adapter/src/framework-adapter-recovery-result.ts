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
  createRunnerRegistry,
  createTuvrenRuntime as createTuvrenRuntimeCore,
  DEFAULT_AGENT_SCHEMA,
} from "@tuvren/runtime";

import {
  assistantText,
  createConformanceIdFactory,
  createConformanceKernelHarness,
  createStaticRunner,
  RUNNER_ID,
} from "./framework-adapter-runtime.ts";
import type { AdapterProjection } from "./framework-adapter-runtime.ts";

interface RecoveryResultDependencies {
  readOperationScenario: (
    input: unknown,
    operation: string
  ) => Record<string, unknown>;
  readProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => unknown;
  readRecordProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => Record<string, unknown>;
  readStringProperty: (
    record: Record<string, unknown>,
    property: string,
    path: string
  ) => string;
}

export const createFrameworkAdapterRecoveryResult =
  (
    dependencies: RecoveryResultDependencies
  ): ((input: unknown) => Promise<AdapterProjection>) =>
  async (input: unknown): Promise<AdapterProjection> => {
    const scenario = dependencies.readOperationScenario(
      input,
      "runtime.recover-result"
    );
    const stagedObject = dependencies.readRecordProperty(
      scenario,
      "stagedObject",
      "runtime.recover-result.stagedObject"
    );
    const taskId = dependencies.readStringProperty(
      stagedObject,
      "taskId",
      "runtime.recover-result.stagedObject.taskId"
    );
    const objectType = dependencies.readStringProperty(
      stagedObject,
      "objectType",
      "runtime.recover-result.stagedObject.objectType"
    );
    const payload = dependencies.readProperty(
      stagedObject,
      "payload",
      "runtime.recover-result.stagedObject.payload"
    );
    const harness = createConformanceKernelHarness();
    const runtime = createTuvrenRuntimeCore({
      createId: createConformanceIdFactory(),
      defaultRunnerId: RUNNER_ID,
      kernel: harness.kernel,
      runnerRegistry: createRunnerRegistry([
        createStaticRunner(() => ({
          messages: [assistantText("recovery placeholder")],
          resolution: {
            reason: "done",
            type: "end_turn",
          },
        })),
      ]),
    });
    const thread = await runtime.createThread({});
    const recoveryTurnId = "shared-recovery-turn";
    const runId = "shared-recovery-run";

    const turn = await harness.kernel.turn.create(
      recoveryTurnId,
      thread.threadId,
      thread.branchId,
      null,
      thread.rootTurnNodeHash
    );
    await harness.kernel.run.create(
      runId,
      turn.turnId,
      thread.branchId,
      DEFAULT_AGENT_SCHEMA.schemaId,
      thread.rootTurnNodeHash,
      [{ deterministic: false, id: taskId, sideEffects: false }]
    );
    await harness.kernel.staging.stage(
      runId,
      new TextEncoder().encode(JSON.stringify(payload)),
      taskId,
      objectType,
      "completed"
    );

    const recovery = await harness.kernel.run.recover(runId);
    const [firstStagedResult] = recovery.uncommittedStagedResults;
    const recoveryProjection = {
      firstObjectType: firstStagedResult?.objectType,
      firstTaskId: firstStagedResult?.taskId,
      lastTurnNodeHash: recovery.lastTurnNodeHash,
      uncommittedStagedResults: recovery.uncommittedStagedResults.length,
    };

    return {
      evidence: {
        recovery: recoveryProjection,
      },
      result: {
        recovery: recoveryProjection,
      },
      state: {
        recovery,
        trace: {
          recovery: {
            evidence: {
              recovery: recoveryProjection,
            },
          },
        },
      },
    };
  };
