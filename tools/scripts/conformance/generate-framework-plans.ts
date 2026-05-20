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

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatGeneratedJson } from "./format-generated-json.ts";

interface PlanCheck {
  assertions: Record<string, unknown>[];
  capabilities?: string[];
  checkId: string;
  controls?: Record<string, unknown>;
  evidence?: string[];
  input?: Record<string, unknown>;
  operation: string;
  scenario?: string;
}

interface Plan {
  applicability: { capabilities: string[] };
  checks: PlanCheck[];
  packetId: string;
  planId: string;
  planVersion: string;
  scenarios?: Record<string, string>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLANS_DIR = resolve(REPO_ROOT, "boundaries/framework/conformance/plans");

await main();

async function main(): Promise<void> {
  // Forward-looking probes against operations not declared by the framework
  // operation source were removed: validate-plans rejects them. Bringing
  // those operations under authority (TypeSpec) is a separate spec amendment.
  const plans: Array<{ fileName: string; plan: Plan }> = [
    {
      fileName: "runtime-api-callables-extended.json",
      plan: buildRuntimeApiCallablesExtended(),
    },
    {
      fileName: "tool-contracts-extended.json",
      plan: buildToolContractsExtended(),
    },
    {
      fileName: "runtime-api-lifecycle-extended.json",
      plan: buildRuntimeApiLifecycleExtended(),
    },
    {
      fileName: "runtime-api-orchestration.json",
      plan: buildRuntimeApiOrchestration(),
    },
    {
      fileName: "event-stream-extended.json",
      plan: buildEventStreamExtended(),
    },
    {
      fileName: "driver-api-extended.json",
      plan: buildDriverApiExtended(),
    },
    {
      fileName: "react-driver-extended.json",
      plan: buildReactDriverExtended(),
    },
  ];

  for (const { fileName, plan } of plans) {
    await writeFile(
      resolve(PLANS_DIR, fileName),
      `${JSON.stringify(plan, null, 2)}\n`
    );
    process.stdout.write(`wrote ${fileName} (${plan.checks.length} checks)\n`);
  }

  await formatGeneratedJson(
    plans.map(({ fileName }) => resolve(PLANS_DIR, fileName))
  );
}

function buildRuntimeApiOrchestration(): Plan {
  return {
    applicability: { capabilities: ["framework.orchestration"] },
    checks: [
      {
        assertions: [
          {
            equals: "orchestration_parent_not_started",
            field: "$.orchestration.launch.preStartSpawnError.code",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.launch.spawn-rejects-before-parent-start",
        evidence: ["orchestration.launch.preStartSpawnError.code"],
        input: { scenarioPath: "$.orchestration-launch-preconditions" },
        operation: "runtime.orchestration.launch-preconditions",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "orchestration_parent_not_started",
            field: "$.orchestration.launch.preStartAwaitResultError.code",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.launch.await-result-rejects-before-parent-start",
        evidence: ["orchestration.launch.preStartAwaitResultError.code"],
        input: { scenarioPath: "$.orchestration-launch-preconditions" },
        operation: "runtime.orchestration.launch-preconditions",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "orchestration_parent_not_started",
            field: "$.orchestration.launch.postAwaitSpawnError.code",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.launch.await-result-does-not-start-parent",
        evidence: ["orchestration.launch.postAwaitSpawnError.code"],
        input: { scenarioPath: "$.orchestration-launch-preconditions" },
        operation: "runtime.orchestration.launch-preconditions",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.launch.childRunsOnOwnThread",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.launch.child-runs-on-own-thread",
        evidence: ["orchestration.launch.childRunsOnOwnThread"],
        input: { scenarioPath: "$.orchestration-launch-preconditions" },
        operation: "runtime.orchestration.launch-preconditions",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.lifecycle.parentPausedWhileChildCompleted",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.lifecycle.parent-pause-child-continues",
        evidence: ["orchestration.lifecycle.parentPausedWhileChildCompleted"],
        input: { scenarioPath: "$.orchestration-parent-pause-child-continues" },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.lifecycle.parentCompletedWhileChildPaused",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.lifecycle.child-pause-parent-completes",
        evidence: ["orchestration.lifecycle.parentCompletedWhileChildPaused"],
        input: { scenarioPath: "$.orchestration-child-pause-parent-completes" },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "completed",
            field: "$.orchestration.lifecycle.childResumedPhase",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.lifecycle.child-resume-stays-local",
        evidence: ["orchestration.lifecycle.childResumedPhase"],
        input: { scenarioPath: "$.orchestration-child-pause-parent-completes" },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field:
              "$.orchestration.lifecycle.childCancelledWhileParentCompleted",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.lifecycle.child-cancel-parent-completes",
        evidence: [
          "orchestration.lifecycle.childCancelledWhileParentCompleted",
        ],
        input: {
          scenarioPath: "$.orchestration-child-cancel-parent-completes",
        },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field:
              "$.orchestration.lifecycle.parentCancelledWhileChildCompleted",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.lifecycle.parent-cancel-child-completes",
        evidence: [
          "orchestration.lifecycle.parentCancelledWhileChildCompleted",
        ],
        input: {
          scenarioPath: "$.orchestration-parent-cancel-child-completes",
        },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "orchestration_parent_inactive",
            field: "$.orchestration.lifecycle.pausedSpawnError.code",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.lifecycle.paused-parent-rejects-spawn",
        evidence: ["orchestration.lifecycle.pausedSpawnError.code"],
        input: { scenarioPath: "$.orchestration-spawn-running-window" },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "orchestration_parent_inactive",
            field: "$.orchestration.lifecycle.completedSpawnError.code",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.lifecycle.completed-parent-rejects-spawn",
        evidence: ["orchestration.lifecycle.completedSpawnError.code"],
        input: { scenarioPath: "$.orchestration-spawn-running-window" },
        operation: "runtime.orchestration.lifecycle-locality",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.eventsSelfOnly",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.surfaces.events-self-only",
        evidence: ["orchestration.surfaces.eventsSelfOnly"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.allEventsIncludeDescendants",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.surfaces.all-events-include-descendants",
        evidence: ["orchestration.surfaces.allEventsIncludeDescendants"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.descendantSourceAttributed",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.surfaces.descendant-source-attributed",
        evidence: ["orchestration.surfaces.descendantSourceAttributed"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "Worker complete.",
            field: "$.orchestration.surfaces.childResult.0.text",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.surfaces.await-result-visible-result",
        evidence: ["orchestration.surfaces.childResult.0.text"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.noCanonicalWorkerResultInjection",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.surfaces.no-worker-result-injection",
        evidence: ["orchestration.surfaces.noCanonicalWorkerResultInjection"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.childAllEventsRemainAvailable",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.surfaces.child-all-events-remains-available",
        evidence: ["orchestration.surfaces.childAllEventsRemainAvailable"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.failedAwaitResultRejected",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.surfaces.await-result-failure-rejects",
        evidence: ["orchestration.surfaces.failedAwaitResultRejected"],
        input: { scenarioPath: "$.orchestration-event-surfaces" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.handoffDescendantAgentPreserved",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration.surfaces.handoff-descendant-agent-preserved",
        evidence: ["orchestration.surfaces.handoffDescendantAgentPreserved"],
        input: { scenarioPath: "$.orchestration-handoff-attribution" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.surfaces.handoffHistoryControlEntryAbsent",
            kind: "evidenceField",
          },
        ],
        checkId:
          "runtime-orchestration-af.handoff-resolution-not-history-entry",
        evidence: ["orchestration.surfaces.handoffHistoryControlEntryAbsent"],
        input: { scenarioPath: "$.orchestration-handoff-attribution" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field:
              "$.orchestration.surfaces.handoffLastOutputOnlyNoSourceSignal",
            kind: "evidenceField",
          },
          {
            equals: "Passing this to reviewer.",
            field: "$.orchestration.surfaces.handoffLastOutputOnlyText",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration-af.handoff-last-output-only-builder",
        evidence: [
          "orchestration.surfaces.handoffLastOutputOnlyNoSourceSignal",
          "orchestration.surfaces.handoffLastOutputOnlyText",
        ],
        input: { scenarioPath: "$.orchestration-handoff-attribution" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "invalid_driver_result",
            field:
              "$.orchestration.surfaces.handoffInvalidCompositionError.code",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration-af.handoff-rejects-multiple-intents",
        evidence: [
          "orchestration.surfaces.handoffInvalidCompositionError.code",
        ],
        input: { scenarioPath: "$.orchestration-handoff-attribution" },
        operation: "runtime.orchestration.event-surfaces",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.inheritance.driverIdInherited",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.inheritance.driver-id",
        evidence: ["orchestration.inheritance.driverIdInherited"],
        input: { scenarioPath: "$.orchestration-execution-inheritance" },
        operation: "runtime.orchestration.execution-inheritance",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.inheritance.toolsInherited",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.inheritance.tools",
        evidence: ["orchestration.inheritance.toolsInherited"],
        input: { scenarioPath: "$.orchestration-execution-inheritance" },
        operation: "runtime.orchestration.execution-inheritance",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.inheritance.schemaInherited",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.inheritance.schema-id",
        evidence: ["orchestration.inheritance.schemaInherited"],
        input: { scenarioPath: "$.orchestration-execution-inheritance" },
        operation: "runtime.orchestration.execution-inheritance",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.nested.rootReceivesGrandchild",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.nested.root-receives-grandchild",
        evidence: ["orchestration.nested.rootReceivesGrandchild"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: true,
            field: "$.orchestration.nested.childReceivesGrandchild",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.nested.child-receives-grandchild",
        evidence: ["orchestration.nested.childReceivesGrandchild"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "worker-2",
            field: "$.orchestration.nested.rootGrandchildSource.agent",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.nested.root-source-agent",
        evidence: ["orchestration.nested.rootGrandchildSource.agent"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            field: "$.orchestration.nested.rootGrandchildSource.threadId",
            kind: "evidenceField",
            matches: "^.+$",
          },
        ],
        checkId: "runtime-orchestration.nested.root-source-thread-id-present",
        evidence: ["orchestration.nested.rootGrandchildSource.threadId"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            field: "$.orchestration.nested.rootGrandchildSource.workerId",
            kind: "evidenceField",
            matches: "^.+$",
          },
        ],
        checkId: "runtime-orchestration.nested.root-source-worker-id-present",
        evidence: ["orchestration.nested.rootGrandchildSource.workerId"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "worker-2",
            field: "$.orchestration.nested.rootGrandchildSource.agent",
            kind: "evidenceField",
          },
          {
            field: "$.orchestration.nested.rootGrandchildSource.threadId",
            kind: "evidenceField",
            matches: "^.+$",
          },
          {
            field: "$.orchestration.nested.rootGrandchildSource.workerId",
            kind: "evidenceField",
            matches: "^.+$",
          },
        ],
        checkId: "runtime-orchestration-af.worker-forwarded-event-source",
        evidence: [
          "orchestration.nested.rootGrandchildSource.agent",
          "orchestration.nested.rootGrandchildSource.threadId",
          "orchestration.nested.rootGrandchildSource.workerId",
        ],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            equals: "worker-2",
            field: "$.orchestration.nested.childGrandchildSource.agent",
            kind: "evidenceField",
          },
        ],
        checkId: "runtime-orchestration.nested.child-source-agent",
        evidence: ["orchestration.nested.childGrandchildSource.agent"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            field: "$.orchestration.nested.childGrandchildSource.threadId",
            kind: "evidenceField",
            matches: "^.+$",
          },
        ],
        checkId: "runtime-orchestration.nested.child-source-thread-id-present",
        evidence: ["orchestration.nested.childGrandchildSource.threadId"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
      {
        assertions: [
          {
            field: "$.orchestration.nested.childGrandchildSource.workerId",
            kind: "evidenceField",
            matches: "^.+$",
          },
        ],
        checkId: "runtime-orchestration.nested.child-source-worker-id-present",
        evidence: ["orchestration.nested.childGrandchildSource.workerId"],
        input: { scenarioPath: "$.orchestration-nested-attribution" },
        operation: "runtime.orchestration.nested-attribution",
        scenario: "runtime-api-scenarios",
      },
    ].map(normalizeGeneratedResultSurfaceCheck),
    packetId: "tuvren.framework.runtime-api",
    planId: "tuvren.framework.runtime-api.orchestration",
    planVersion: "0.1.0",
    scenarios: {
      "runtime-api-scenarios": "../scenarios/runtime-api-scenarios.json",
    },
  };
}

// Tool-contracts extended plan — owns the AF-promoted tool/approval-result
// checks that KRT-AL002 G1 relocated out of `runtime-api-callables-extended`
// into the new `tuvren.framework.tool-contracts` authority packet. The
// generator must emit these checks here (not under runtime-callable-af.*)
// or the next legitimate regeneration would resurrect the retired IDs and
// silently undo the migration.
function buildToolContractsExtended(): Plan {
  const checks: PlanCheck[] = [
    {
      assertions: [
        {
          equals: true,
          field: "$.provider.stream.toolCallIdOwnedByFramework",
          kind: "evidenceField",
        },
        {
          equals: "native-call-1",
          field:
            "$.provider.stream.response.parts.0.providerMetadata.providerCallId",
          kind: "evidenceField",
        },
      ],
      checkId: "tool-contracts-af.tool-call-id-owned-by-framework",
      evidence: [
        "provider.stream.response.parts.0.providerMetadata.providerCallId",
        "provider.stream.toolCallIdOwnedByFramework",
      ],
      input: { scenarioPath: "$.provider-stream-tool-call-native" },
      operation: "runtime.provider-stream",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.tool.execution.toolResults.0.isError",
          kind: "evidenceField",
        },
        {
          equals: "shared tool failed",
          field: "$.tool.execution.toolResults.0.output.error",
          kind: "evidenceField",
        },
        {
          equals: "completed",
          field: "$.toolExecution.status.phase",
          kind: "stateField",
        },
      ],
      checkId:
        "tool-contracts-af.tool-failure-produces-error-result-not-run-fail",
      evidence: [
        "tool.execution.toolResults.0.isError",
        "tool.execution.toolResults.0.output.error",
        "toolExecution.status.phase",
      ],
      input: { scenarioPath: "$.tool-execute-failure" },
      operation: "runtime.tool-execute",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.tool.execution.parallelWaveStartedBeforeResults",
          kind: "evidenceField",
        },
      ],
      checkId: "tool-contracts-af.tool-parallel-wave-starts-before-results",
      evidence: [
        "tool.execution.eventTypes",
        "tool.execution.parallelWaveStartedBeforeResults",
      ],
      input: { scenarioPath: "$.tool-execute-parallel-wave" },
      operation: "runtime.tool-execute",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "Rejected by shared conformance.",
          field: "$.approval.messageAttachment",
          kind: "evidenceField",
        },
      ],
      checkId: "tool-contracts-af.approval-message-attaches-to-tool-result",
      evidence: ["approval.messageAttachment"],
      input: { scenarioPath: "$.paused-turn-reject" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.approval.gatedToolStartAfterResume",
          kind: "evidenceField",
        },
      ],
      checkId: "tool-contracts-af.mixed-approval-gated-tool-start-after-resume",
      evidence: [
        "approval.resumedEventTypes",
        "approval.gatedToolStartAfterResume",
      ],
      input: { scenarioPath: "$.paused-turn-resume" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    },
  ];

  return {
    // The tool-contracts plan exercises a distinct portable surface — tool
    // calls, approval boundaries, parallel-tool ordering — that is
    // adjacent to but separate from the broader `framework.runtime-api`
    // surface. Tagging the plan with its own `framework.tool-contracts`
    // capability lets the compatibility matrix distinguish "runtime API
    // supported" from "tool-contract surface supported", so an adapter
    // that implements one but not the other surfaces as a partial-coverage
    // signal instead of being silently folded into the runtime-api bucket.
    applicability: { capabilities: ["framework.tool-contracts"] },
    checks: checks.map(normalizeGeneratedResultSurfaceCheck),
    packetId: "tuvren.framework.tool-contracts",
    planId: "tuvren.framework.tool-contracts.extended",
    planVersion: "0.2.0",
    scenarios: {
      "runtime-api-scenarios": "../scenarios/runtime-api-scenarios.json",
    },
  };
}

// Runtime API callables — extends shape and value coverage of the six
// per-callable operations that the typescript adapter implements.
function buildRuntimeApiCallablesExtended(): Plan {
  const checks: PlanCheck[] = [];

  // runtime.provider-generate
  const providerGenerate = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `runtime-callable-ext.provider-generate.${id}`,
    evidence,
    input: { scenarioPath: "$.provider-generate-text" },
    operation: "runtime.provider-generate",
    scenario: "runtime-api-scenarios",
  });
  checks.push(
    providerGenerate(
      "call-count-positive",
      { field: "$.provider.generate.callCount", kind: "evidenceField" },
      ["provider.generate.callCount"]
    ),
    providerGenerate(
      "response-parts-first-present",
      { field: "$.provider.generate.response.parts.0", kind: "evidenceField" },
      ["provider.generate.response.parts.0"]
    ),
    providerGenerate(
      "finish-reason-string",
      // Spec defines tool_call (singular) and includes error; reject the
      // common tool_calls typo and keep stop/length/content_filter accepted.
      {
        field: "$.provider.generate.response.finishReason",
        kind: "evidenceField",
        matches: "^(stop|length|content_filter|tool_call|error)$",
      },
      ["provider.generate.response.finishReason"]
    ),
    providerGenerate(
      "first-part-text-shape",
      {
        field: "$.provider.generate.response.parts.0.type",
        kind: "evidenceField",
        equals: "text",
      },
      ["provider.generate.response.parts.0.type"]
    ),
    providerGenerate(
      "response-finish-reason-equals-stop",
      {
        equals: "stop",
        field: "$.provider.generate.response.finishReason",
        kind: "evidenceField",
      },
      ["provider.generate.response.finishReason"]
    ),
    {
      assertions: [
        {
          equals: "shared docs",
          field: "$.provider.generate.response.parts.0.input.query",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.content-tool-call-input-parsed",
      evidence: ["provider.generate.response.parts.0.input.query"],
      input: { scenarioPath: "$.provider-generate-tool-call" },
      operation: "runtime.provider-generate",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: 42,
          field: "$.provider.generate.response.parts.0.data.answer",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.content-structured-data-parsed",
      evidence: ["provider.generate.response.parts.0.data.answer"],
      input: { scenarioPath: "$.provider-generate-structured" },
      operation: "runtime.provider-generate",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: ["type", "name", "data"],
          field: "$.provider.generate.partKeys.0",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.structured-provider-native-type-hidden",
      evidence: ["provider.generate.partKeys.0"],
      input: { scenarioPath: "$.provider-generate-structured" },
      operation: "runtime.provider-generate",
      scenario: "runtime-api-scenarios",
    }
  );

  // runtime.provider-stream
  const providerStream = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `runtime-callable-ext.provider-stream.${id}`,
    evidence,
    input: { scenarioPath: "$.provider-stream-text" },
    operation: "runtime.provider-stream",
    scenario: "runtime-api-scenarios",
  });
  checks.push(
    providerStream(
      "chunk-types-include-finish",
      {
        contains: "finish",
        field: "$.provider.stream.chunkTypes",
        kind: "evidenceField",
      },
      ["provider.stream.chunkTypes"]
    ),
    providerStream(
      "emitted-event-types-text-delta",
      {
        contains: "text.delta",
        field: "$.provider.stream.emittedEventTypes",
        kind: "evidenceField",
      },
      ["provider.stream.emittedEventTypes"]
    ),
    providerStream(
      "emitted-event-types-include-message-start",
      {
        contains: "message.start",
        field: "$.provider.stream.emittedEventTypes",
        kind: "evidenceField",
      },
      ["provider.stream.emittedEventTypes"]
    ),
    providerStream(
      "emitted-event-types-include-message-done",
      {
        contains: "message.done",
        field: "$.provider.stream.emittedEventTypes",
        kind: "evidenceField",
      },
      ["provider.stream.emittedEventTypes"]
    ),
    providerStream(
      "chunk-types-text-delta-first",
      {
        equals: "text_delta",
        field: "$.provider.stream.chunkTypes.0",
        kind: "evidenceField",
      },
      ["provider.stream.chunkTypes.0"]
    ),
    providerStream(
      "response-text-matches-scenario",
      {
        equals: "streamed from shared scenario",
        field: "$.provider.stream.response.parts.0.text",
        kind: "evidenceField",
      },
      ["provider.stream.response.parts.0.text"]
    ),
    {
      assertions: [
        {
          equals: 1,
          field: "$.provider.stream.structuredDeltaIndex",
          kind: "evidenceField",
        },
        {
          equals: 2,
          field: "$.provider.stream.structuredDoneIndex",
          kind: "evidenceField",
        },
      ],
      checkId:
        "runtime-callable-af.structured-stream-synthesizes-delta-before-done",
      evidence: [
        "provider.stream.structuredDeltaIndex",
        "provider.stream.structuredDoneIndex",
      ],
      input: { scenarioPath: "$.provider-stream-structured-final" },
      operation: "runtime.provider-stream",
      scenario: "runtime-api-scenarios",
    }
    // KRT-AL002 G1 relocated `runtime-callable-af.tool-call-id-owned-by-framework`
    // to the tool-contracts plan. See `buildToolContractsExtended`.
  );

  // runtime.tool-execute
  const toolExecute = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `runtime-callable-ext.tool-execute.${id}`,
    evidence,
    input: { scenarioPath: "$.tool-execute-search" },
    operation: "runtime.tool-execute",
    scenario: "runtime-api-scenarios",
  });
  checks.push(
    toolExecute(
      "call-count-equals-one",
      { equals: 1, field: "$.tool.execution.callCount", kind: "evidenceField" },
      ["tool.execution.callCount"]
    ),
    toolExecute(
      "input-query-matches",
      {
        equals: "shared docs",
        field: "$.tool.execution.inputs.0.query",
        kind: "evidenceField",
      },
      ["tool.execution.inputs.0.query"]
    ),
    toolExecute(
      "output-source-matches",
      {
        equals: "shared scenario",
        field: "$.tool.execution.outputs.0.source",
        kind: "evidenceField",
      },
      ["tool.execution.outputs.0.source"]
    ),
    toolExecute(
      "output-shape-matches-scenario",
      {
        kind: "schemaValid",
        path: "$.evidence.tool.execution.outputs.0",
        schema: "$.scenario.toolResultSchema",
      },
      ["tool.execution.outputs.0"]
    ),
    toolExecute(
      "state-phase-completed",
      {
        equals: "completed",
        field: "$.toolExecution.status.phase",
        kind: "stateField",
      },
      ["toolExecution.status.phase"]
    ),
    toolExecute(
      "state-tool-results-total-one",
      {
        equals: 1,
        field: "$.toolExecution.status.manifest.toolResults.total",
        kind: "stateField",
      },
      ["toolExecution.status.manifest.toolResults.total"]
    )
    // KRT-AL002 G1 relocated `tool-failure-produces-error-result-not-run-fail`
    // and `tool-parallel-wave-starts-before-results` to the tool-contracts
    // plan. See `buildToolContractsExtended`.
  );

  // runtime.approval-resolve
  const approvalResolve = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `runtime-callable-ext.approval-resolve.${id}`,
    evidence,
    input: { scenarioPath: "$.paused-turn-resume" },
    operation: "runtime.approval-resolve",
    scenario: "runtime-api-scenarios",
  });
  checks.push(
    approvalResolve(
      "paused-phase-paused",
      {
        equals: "paused",
        field: "$.approval.pausedPhase",
        kind: "evidenceField",
      },
      ["approval.pausedPhase"]
    ),
    approvalResolve(
      "resumed-phase-completed",
      {
        equals: "completed",
        field: "$.approval.resumedPhase",
        kind: "evidenceField",
      },
      ["approval.resumedPhase"]
    ),
    approvalResolve(
      "executed-tools-include-search",
      {
        contains: "search",
        field: "$.tool.execution.executedNames",
        kind: "evidenceField",
      },
      ["tool.execution.executedNames"]
    ),
    approvalResolve(
      "executed-tools-include-email",
      {
        contains: "email",
        field: "$.tool.execution.executedNames",
        kind: "evidenceField",
      },
      ["tool.execution.executedNames"]
    ),
    approvalResolve(
      "decision-call-id-matches",
      {
        equals: "call-email",
        field: "$.approval.decisions.0.callId",
        kind: "evidenceField",
      },
      ["approval.decisions.0.callId"]
    ),
    approvalResolve(
      "decision-type-approve",
      {
        equals: "approve",
        field: "$.approval.decisions.0.type",
        kind: "evidenceField",
      },
      ["approval.decisions.0.type"]
    ),
    approvalResolve(
      "paused-approval-call-id-matches",
      {
        equals: "call-email",
        field: "$.approval.pausedApprovalCallIds.0",
        kind: "evidenceField",
      },
      ["approval.pausedApprovalCallIds.0"]
    ),
    approvalResolve(
      "executed-before-resume-stays-pre-approval",
      {
        equals: ["search"],
        field: "$.tool.execution.executedNamesBeforeResume",
        kind: "evidenceField",
      },
      ["tool.execution.executedNamesBeforeResume"]
    ),
    approvalResolve(
      "executed-after-resume-includes-approved-tool",
      {
        equals: ["search", "email"],
        field: "$.tool.execution.executedNamesAfterResume",
        kind: "evidenceField",
      },
      ["tool.execution.executedNamesAfterResume"]
    ),
    approvalResolve(
      "paused-event-types-include-approval-requested",
      {
        contains: "approval.requested",
        field: "$.approval.pausedEventTypes",
        kind: "evidenceField",
      },
      ["approval.pausedEventTypes"]
    ),
    approvalResolve(
      "resumed-event-types-include-approval-resolved",
      {
        contains: "approval.resolved",
        field: "$.approval.resumedEventTypes",
        kind: "evidenceField",
      },
      ["approval.resumedEventTypes"]
    ),
    {
      assertions: [
        {
          equals: true,
          field: "$.approval.sameTurn",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.approval-resume-same-turn",
      evidence: ["approval.sameTurn"],
      input: { scenarioPath: "$.paused-turn-resume" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: ["search"],
          field: "$.tool.execution.executedNamesBeforeResume",
          kind: "evidenceField",
        },
        {
          equals: ["search", "email"],
          field: "$.tool.execution.executedNamesAfterResume",
          kind: "evidenceField",
        },
      ],
      checkId:
        "runtime-callable-af.approval-resume-reruns-unfinished-tools-only",
      evidence: [
        "tool.execution.executedNamesBeforeResume",
        "tool.execution.executedNamesAfterResume",
      ],
      input: { scenarioPath: "$.paused-turn-resume" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "invalid_approval_resolution",
          field: "$.approval.handleOwnership.cancelErrorCode",
          kind: "evidenceField",
        },
        {
          equals: "invalid_approval_resolution",
          field: "$.approval.handleOwnership.resolveApprovalErrorCode",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.approval-resume-new-handle-only",
      evidence: [
        "approval.handleOwnership.cancelErrorCode",
        "approval.handleOwnership.resolveApprovalErrorCode",
        "approval.resumedPhase",
      ],
      input: { scenarioPath: "$.paused-turn-resume" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.approval.toolResults.1.isError",
          kind: "evidenceField",
        },
        {
          equals: "reject",
          field: "$.approval.toolResults.1.output.decisionType",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.approval-reject-stages-tool-result",
      evidence: [
        "approval.toolResults.1.isError",
        "approval.toolResults.1.output.decisionType",
      ],
      input: { scenarioPath: "$.paused-turn-reject" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    },
    // KRT-AL002 G1 relocated `approval-message-attaches-to-tool-result` to
    // the tool-contracts plan. See `buildToolContractsExtended`.
    {
      assertions: [
        {
          equals: "completed",
          field: "$.approval.cancelledPhase",
          kind: "evidenceField",
        },
        {
          equals: true,
          field: "$.approval.cancelledToolResults.1.isError",
          kind: "evidenceField",
        },
        {
          equals: "reject",
          field: "$.approval.cancelledToolResults.1.output.decisionType",
          kind: "evidenceField",
        },
        {
          equals: true,
          field: "$.approval.resumedTextAbsent",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.paused-cancel-rejection-and-stop",
      evidence: [
        "approval.cancelledPhase",
        "approval.cancelledToolResults.1.isError",
        "approval.resumedTextAbsent",
        "tool.execution.executedNamesAfterCancel",
      ],
      input: { scenarioPath: "$.paused-turn-cancel" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
    }
    // KRT-AL002 G1 relocated `mixed-approval-gated-tool-start-after-resume`
    // to the tool-contracts plan. See `buildToolContractsExtended`.
  );

  // runtime.validate-structured-output
  const validateStructured = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[]
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `runtime-callable-ext.validate-structured-output.${id}`,
    evidence,
    input: { scenarioPath: "$.structured-validation-failure" },
    operation: "runtime.validate-structured-output",
    scenario: "runtime-api-scenarios",
  });
  checks.push(
    validateStructured(
      "resolution-fail",
      {
        equals: "fail",
        field: "$.validation.resolutionType",
        kind: "evidenceField",
      },
      ["validation.resolutionType"]
    ),
    validateStructured(
      "resolution-type-string",
      {
        field: "$.validation.resolutionType",
        kind: "evidenceField",
        matches: "^(fail|repair|warn|pass)$",
      },
      ["validation.resolutionType"]
    ),
    {
      assertions: [
        {
          equals: "draft-07",
          field: "$.validation.dialect",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.structured-output-default-draft07",
      evidence: ["validation.dialect"],
      input: { scenarioPath: "$.structured-validation-failure" },
      operation: "runtime.validate-structured-output",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "structured_output_validation",
          field: "$.validation.error.code",
          kind: "evidenceField",
        },
        {
          equals: "fail",
          field: "$.validation.resolutionType",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.structured-validation-hard-fail-code",
      evidence: ["validation.error.code", "validation.resolutionType"],
      input: { scenarioPath: "$.structured-validation-failure" },
      operation: "runtime.validate-structured-output",
      scenario: "runtime-api-scenarios",
    }
  );

  // runtime.cancel-execution
  checks.push(
    {
      assertions: [
        {
          equals: "turn.start",
          field: "$.cancellation.observedEventType",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-ext.cancel-execution.observed-event-type",
      controls: { cancelAfterEvent: "turn.start", deadlineMs: 1000 },
      evidence: ["cancellation.observedEventType"],
      operation: "runtime.cancel-execution",
    },
    {
      assertions: [
        {
          equals: 0,
          field: "$.cancellation.observedEventIndex",
          kind: "evidenceField",
        },
      ],
      checkId:
        "runtime-callable-ext.cancel-execution.observed-event-index-zero",
      controls: { cancelAfterEvent: "turn.start", deadlineMs: 1000 },
      evidence: ["cancellation.observedEventIndex"],
      operation: "runtime.cancel-execution",
    },
    {
      assertions: [
        {
          equals: 2,
          field: "$.cancellation.cancelInvocations",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-ext.cancel-execution.cancel-invocation-count",
      controls: { cancelAfterEvent: "turn.start", deadlineMs: 1000 },
      evidence: ["cancellation.cancelInvocations"],
      operation: "runtime.cancel-execution",
    },
    {
      assertions: [
        {
          equals: 1,
          field: "$.cancellation.errorEventCount",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-ext.cancel-execution.error-event-count-one",
      controls: { cancelAfterEvent: "turn.start", deadlineMs: 1000 },
      evidence: ["cancellation.errorEventCount"],
      operation: "runtime.cancel-execution",
    },
    {
      assertions: [
        {
          equals: "failed",
          field: "$.runtime.phase",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-ext.cancel-execution.runtime-phase-failed",
      controls: { cancelAfterEvent: "turn.start", deadlineMs: 1000 },
      evidence: ["runtime.phase"],
      operation: "runtime.cancel-execution",
    }
  );

  // runtime.durable-read.* (KRT-AO003 – KRT-AO005)
  checks.push(
    // list-threads
    {
      assertions: [{ equals: 2, field: "$.durableRead.listThreads.threadCount", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads.thread-count-positive",
      evidence: ["result.durableRead.listThreads.threadCount"],
      operation: "runtime.durable-read.list-threads",
    },
    {
      assertions: [{ equals: false, field: "$.durableRead.listThreads.hasCursor", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads.no-cursor-when-all-consumed",
      evidence: ["result.durableRead.listThreads.hasCursor"],
      operation: "runtime.durable-read.list-threads",
    },
    // list-threads-paginate
    {
      assertions: [{ equals: 1, field: "$.durableRead.listThreads.page1Count", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-paginate.page1-count-one",
      evidence: ["result.durableRead.listThreads.page1Count"],
      operation: "runtime.durable-read.list-threads-paginate",
    },
    {
      assertions: [{ equals: true, field: "$.durableRead.listThreads.hasFirstCursor", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-paginate.has-next-cursor",
      evidence: ["result.durableRead.listThreads.hasFirstCursor"],
      operation: "runtime.durable-read.list-threads-paginate",
    },
    {
      assertions: [{ equals: 1, field: "$.durableRead.listThreads.page2Count", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-paginate.page2-count-one",
      evidence: ["result.durableRead.listThreads.page2Count"],
      operation: "runtime.durable-read.list-threads-paginate",
    },
    {
      assertions: [{ equals: false, field: "$.durableRead.listThreads.hasSecondCursor", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-paginate.no-cursor-on-last-page",
      evidence: ["result.durableRead.listThreads.hasSecondCursor"],
      operation: "runtime.durable-read.list-threads-paginate",
    },
    {
      assertions: [{ equals: 2, field: "$.durableRead.listThreads.uniqueIds", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-paginate.unique-thread-count",
      evidence: ["result.durableRead.listThreads.uniqueIds"],
      operation: "runtime.durable-read.list-threads-paginate",
    },
    // list-threads-capability-rejected
    {
      assertions: [{ equals: true, field: "$.durableRead.listThreads.raised", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-cap-rejected.raised-true",
      evidence: ["result.durableRead.listThreads.raised"],
      operation: "runtime.durable-read.list-threads-capability-rejected",
    },
    {
      assertions: [{ equals: "kernel_capability_unsupported", field: "$.durableRead.listThreads.errorCode", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-threads-cap-rejected.error-code",
      evidence: ["result.durableRead.listThreads.errorCode"],
      operation: "runtime.durable-read.list-threads-capability-rejected",
    },
    // list-branches
    {
      assertions: [{ equals: 2, field: "$.durableRead.listBranches.branchCount", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-branches.branch-count",
      evidence: ["result.durableRead.listBranches.branchCount"],
      operation: "runtime.durable-read.list-branches",
    },
    {
      assertions: [{ equals: true, field: "$.durableRead.listBranches.allHaveThreadId", kind: "resultField" }],
      checkId: "runtime-callable-ao.list-branches.all-have-thread-id",
      evidence: ["result.durableRead.listBranches.allHaveThreadId"],
      operation: "runtime.durable-read.list-branches",
    },
    // get-turn-state
    {
      assertions: [{ equals: true, field: "$.durableRead.getTurnState.hasTurnNodeHash", kind: "resultField" }],
      checkId: "runtime-callable-ao.get-turn-state.has-turn-node-hash",
      evidence: ["result.durableRead.getTurnState.hasTurnNodeHash"],
      operation: "runtime.durable-read.get-turn-state",
    },
    {
      assertions: [{ equals: true, field: "$.durableRead.getTurnState.hasTurnTreeHash", kind: "resultField" }],
      checkId: "runtime-callable-ao.get-turn-state.has-turn-tree-hash",
      evidence: ["result.durableRead.getTurnState.hasTurnTreeHash"],
      operation: "runtime.durable-read.get-turn-state",
    },
    {
      assertions: [{ equals: true, field: "$.durableRead.getTurnState.previousTurnNull", kind: "resultField" }],
      checkId: "runtime-callable-ao.get-turn-state.previous-turn-null",
      evidence: ["result.durableRead.getTurnState.previousTurnNull"],
      operation: "runtime.durable-read.get-turn-state",
    },
    // get-turn-state-lineage
    {
      assertions: [{ equals: true, field: "$.durableRead.getTurnState.matchesExpectedHash", kind: "resultField" }],
      checkId: "runtime-callable-ao.get-turn-state-lineage.matches-expected-hash",
      evidence: ["result.durableRead.getTurnState.matchesExpectedHash"],
      operation: "runtime.durable-read.get-turn-state-lineage",
    },
    // get-turn-history
    {
      assertions: [{ equals: 1, field: "$.durableRead.getTurnHistory.snapshotCount", kind: "resultField" }],
      checkId: "runtime-callable-ao.get-turn-history.snapshot-count-one",
      evidence: ["result.durableRead.getTurnHistory.snapshotCount"],
      operation: "runtime.durable-read.get-turn-history",
    },
    {
      assertions: [{ equals: true, field: "$.durableRead.getTurnHistory.firstSnapshotHasHash", kind: "resultField" }],
      checkId: "runtime-callable-ao.get-turn-history.first-snapshot-has-hash",
      evidence: ["result.durableRead.getTurnHistory.firstSnapshotHasHash"],
      operation: "runtime.durable-read.get-turn-history",
    },
    // read-branch-messages
    {
      assertions: [{ equals: 0, field: "$.durableRead.readBranchMessages.messageCount", kind: "resultField" }],
      checkId: "runtime-callable-ao.read-branch-messages.message-count-zero",
      evidence: ["result.durableRead.readBranchMessages.messageCount"],
      operation: "runtime.durable-read.read-branch-messages",
    },
    {
      assertions: [{ equals: false, field: "$.durableRead.readBranchMessages.hasCursor", kind: "resultField" }],
      checkId: "runtime-callable-ao.read-branch-messages.no-cursor",
      evidence: ["result.durableRead.readBranchMessages.hasCursor"],
      operation: "runtime.durable-read.read-branch-messages",
    },
    // read-branch-messages-head-drift
    {
      assertions: [{ equals: true, field: "$.durableRead.readBranchMessages.raised", kind: "resultField" }],
      checkId: "runtime-callable-ao.read-branch-messages-head-drift.raised-true",
      evidence: ["result.durableRead.readBranchMessages.raised"],
      operation: "runtime.durable-read.read-branch-messages-head-drift",
    },
    {
      assertions: [{ equals: "durable_read_cursor_head_drift", field: "$.durableRead.readBranchMessages.errorCode", kind: "resultField" }],
      checkId: "runtime-callable-ao.read-branch-messages-head-drift.error-code",
      evidence: ["result.durableRead.readBranchMessages.errorCode"],
      operation: "runtime.durable-read.read-branch-messages-head-drift",
    }
  );

  return {
    applicability: { capabilities: ["framework.runtime-api"] },
    checks: checks.map(normalizeGeneratedResultSurfaceCheck),
    packetId: "tuvren.framework.runtime-api",
    planId: "tuvren.framework.runtime-api.callables-extended",
    // KRT-AL002 G1 bumped this plan to 0.2.0 when it relocated the five
    // AF tool/approval-result checks out into the new
    // `tuvren.framework.tool-contracts` plan (removing a check is major
    // per TechSpec §2.1 in the live 0.x line).
    // KRT-AO003–AO005 bumped to 0.3.0 when the 21 durable-read checks were added.
    planVersion: "0.3.0",
    scenarios: {
      "runtime-api-scenarios": "../scenarios/runtime-api-scenarios.json",
    },
  };
}

// Runtime API lifecycle — extends evidence assertions on each lifecycle
// callable, adding shape/range checks beyond the single-field originals.
function buildRuntimeApiLifecycleExtended(): Plan {
  const checks: PlanCheck[] = [];

  // execute-turn
  checks.push(
    {
      assertions: [
        {
          equals: "completed",
          field: "$.runtime.phase",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-ext.execute-turn.phase-completed",
      evidence: ["runtime.phase"],
      input: { scenarioPath: "$.completed-turn" },
      operation: "runtime.execute-turn",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          field: "$.runtime.phase",
          kind: "evidenceField",
          matches: "^(running|paused|completed|failed)$",
        },
      ],
      checkId: "runtime-lifecycle-ext.execute-turn.phase-enum",
      evidence: ["runtime.phase"],
      input: { scenarioPath: "$.completed-turn" },
      operation: "runtime.execute-turn",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: false,
          field: "$.inputSignal.accepted",
          kind: "evidenceField",
        },
        {
          equals: "invalid_tuvren_message",
          field: "$.inputSignal.error.code",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-callable-af.input-signal-empty-parts-rejected",
      evidence: ["inputSignal.error.code", "inputSignal.accepted"],
      input: { scenarioPath: "$.input-signal-empty-parts" },
      operation: "runtime.execute-turn",
      scenario: "runtime-api-scenarios",
    }
  );

  // approval-resolve trace step — steps are required for $.trace.* paths to
  // resolve; without steps the runner runs single-dispatch and never builds
  // the trace dictionary the assertion reads.
  checks.push(
    {
      assertions: [
        {
          equals: "paused",
          field: "$.trace.approval.evidence.approval.pausedPhase",
          kind: "stateField",
        },
      ],
      checkId: "runtime-lifecycle-ext.approval-resolve.paused-phase-trace",
      evidence: ["trace.approval.evidence.approval.pausedPhase"],
      input: { scenarioPath: "$.paused-turn-resume" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
      steps: [
        {
          input: { scenarioPath: "$.paused-turn-resume" },
          operation: "runtime.approval-resolve",
          stepId: "approval",
        },
      ],
    } as PlanCheck,
    {
      assertions: [
        {
          equals: "completed",
          field: "$.trace.approval.evidence.approval.resumedPhase",
          kind: "stateField",
        },
      ],
      checkId: "runtime-lifecycle-ext.approval-resolve.resumed-phase-trace",
      evidence: ["trace.approval.evidence.approval.resumedPhase"],
      input: { scenarioPath: "$.paused-turn-resume" },
      operation: "runtime.approval-resolve",
      scenario: "runtime-api-scenarios",
      steps: [
        {
          input: { scenarioPath: "$.paused-turn-resume" },
          operation: "runtime.approval-resolve",
          stepId: "approval",
        },
      ],
    } as PlanCheck
  );

  // branch-create assertions (single-shot via state)
  checks.push(
    {
      assertions: [
        {
          equals: "completed",
          field: "$.branch.completedTurnPhase",
          kind: "stateField",
        },
      ],
      checkId: "runtime-lifecycle-ext.branch-create.source-phase-completed",
      evidence: ["branch.completedTurnPhase"],
      input: { scenarioPath: "$.branch-from-completed-head" },
      operation: "runtime.branch-create",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: 2,
          field: "$.branch.sourceMessageCount",
          kind: "stateField",
        },
      ],
      checkId: "runtime-lifecycle-ext.branch-create.source-message-count",
      evidence: ["branch.sourceMessageCount"],
      input: { scenarioPath: "$.branch-from-completed-head" },
      operation: "runtime.branch-create",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          field: "$.branch.sourceHeadTurnNodeHash",
          kind: "stateField",
          matches: "^[a-f0-9]{64}$",
        },
      ],
      checkId: "runtime-lifecycle-ext.branch-create.source-head-hash-format",
      evidence: ["branch.sourceHeadTurnNodeHash"],
      input: { scenarioPath: "$.branch-from-completed-head" },
      operation: "runtime.branch-create",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          field: "$.branch.createdHeadTurnNodeHash",
          kind: "stateField",
          matches: "^[a-f0-9]{64}$",
        },
      ],
      checkId: "runtime-lifecycle-ext.branch-create.created-head-hash-format",
      evidence: ["branch.createdHeadTurnNodeHash"],
      input: { scenarioPath: "$.branch-from-completed-head" },
      operation: "runtime.branch-create",
      scenario: "runtime-api-scenarios",
    }
  );

  // context-transform
  checks.push(
    {
      assertions: [
        {
          equals: 3,
          field: "$.context.messageCount",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-ext.context-transform.message-count",
      evidence: ["context.messageCount"],
      input: { scenarioPath: "$.context-transform-append-summary" },
      operation: "runtime.context-transform",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "Shared context engineering summary.",
          field: "$.context.summaryText",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-ext.context-transform.summary-text",
      evidence: ["context.summaryText"],
      input: { scenarioPath: "$.context-transform-append-summary" },
      operation: "runtime.context-transform",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "completed",
          field: "$.runtime.phase",
          kind: "evidenceField",
        },
      ],
      checkId:
        "runtime-lifecycle-ext.context-transform.runtime-phase-completed",
      evidence: ["runtime.phase"],
      input: { scenarioPath: "$.context-transform-append-summary" },
      operation: "runtime.context-transform",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.context.createdNewHead",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-af.context-transform-creates-new-tree-heads",
      evidence: ["context.createdNewHead"],
      input: { scenarioPath: "$.context-transform-append-summary" },
      operation: "runtime.context-transform",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: 1,
          field: "$.context.sourceMessageCount",
          kind: "evidenceField",
        },
        {
          equals: [1, 2, 3],
          field: "$.context.snapshotMessageCounts",
          kind: "evidenceField",
        },
      ],
      checkId:
        "runtime-lifecycle-af.context-transform-preserves-source-checkpoint",
      evidence: ["context.sourceMessageCount", "context.snapshotMessageCounts"],
      input: { scenarioPath: "$.context-transform-append-summary" },
      operation: "runtime.context-transform",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: 2,
          field: "$.context.rewrittenMessageCount",
          kind: "evidenceField",
        },
        {
          equals: 2,
          field: "$.context.driverObservedMessageCount",
          kind: "evidenceField",
        },
      ],
      checkId:
        "runtime-lifecycle-af.context-transform-driver-sees-rewritten-context",
      evidence: [
        "context.rewrittenMessageCount",
        "context.driverObservedMessageCount",
      ],
      input: { scenarioPath: "$.context-transform-append-summary" },
      operation: "runtime.context-transform",
      scenario: "runtime-api-scenarios",
    }
  );

  checks.push(
    {
      assertions: [
        {
          equals: 2,
          field: "$.cancellation.cancelInvocations",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.cancellation.errorEventCount",
          kind: "evidenceField",
        },
        {
          equals: "failed",
          field: "$.runtime.phase",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-af.cancel-running-idempotent-fails-once",
      evidence: [
        "cancellation.cancelInvocations",
        "cancellation.errorEventCount",
        "runtime.phase",
      ],
      controls: { cancelAfterEvent: "turn.start", deadlineMs: 1000 },
      operation: "runtime.cancel-execution",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.cancellation.runtimeStatusPartial",
          kind: "evidenceField",
        },
        {
          equals: "interrupted",
          field: "$.cancellation.partialAssistantText",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-af.cancel-running-stages-partial-status",
      evidence: [
        "cancellation.runtimeStatusPartial",
        "cancellation.partialAssistantText",
      ],
      controls: { cancelAfterEvent: "iteration.end", deadlineMs: 1000 },
      operation: "runtime.cancel-execution",
    }
  );

  // recover-result
  checks.push(
    {
      assertions: [
        {
          equals: 1,
          field: "$.recovery.uncommittedStagedResults",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-ext.recover-result.uncommitted-count",
      evidence: ["recovery.uncommittedStagedResults"],
      input: { scenarioPath: "$.recover-staged-result" },
      operation: "runtime.recover-result",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "tool-search",
          field: "$.recovery.firstTaskId",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-ext.recover-result.first-task-id",
      evidence: ["recovery.firstTaskId"],
      input: { scenarioPath: "$.recover-staged-result" },
      operation: "runtime.recover-result",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "message",
          field: "$.recovery.firstObjectType",
          kind: "evidenceField",
        },
      ],
      checkId: "runtime-lifecycle-ext.recover-result.first-object-type",
      evidence: ["recovery.firstObjectType"],
      input: { scenarioPath: "$.recover-staged-result" },
      operation: "runtime.recover-result",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          field: "$.recovery.lastTurnNodeHash",
          kind: "evidenceField",
          matches: "^[a-f0-9]{64}$",
        },
      ],
      checkId:
        "runtime-lifecycle-ext.recover-result.last-turn-node-hash-format",
      evidence: ["recovery.lastTurnNodeHash"],
      input: { scenarioPath: "$.recover-staged-result" },
      operation: "runtime.recover-result",
      scenario: "runtime-api-scenarios",
    }
  );

  // recover-stale-run remains a promoted run-liveness extension owned by the
  // runtime API packet, so keep its shared checks in the lifecycle plan.
  checks.push(
    {
      assertions: [
        {
          equals: true,
          field: "$.recovery.sameTurn",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.recovery.originalUserMessageCount",
          kind: "evidenceField",
        },
        {
          equals: true,
          field: "$.recovery.recoveredAssistantVisible",
          kind: "evidenceField",
        },
        {
          equals: "failed",
          field: "$.recovery.staleRunStatus",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.recovery.preemptCalls",
          kind: "evidenceField",
        },
      ],
      capabilities: ["framework.run-liveness"],
      checkId: "runtime-lifecycle-ext.stale-recovery.same-signal-iterate",
      evidence: [
        "recovery.sameTurn",
        "recovery.originalUserMessageCount",
        "recovery.recoveredAssistantVisible",
        "recovery.staleRunStatus",
        "recovery.preemptCalls",
      ],
      input: { scenarioPath: "$.stale-recovery-same-signal-iterate" },
      operation: "runtime.recover-stale-run",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: false,
          field: "$.recovery.sameTurn",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.recovery.originalUserMessageCount",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.recovery.freshUserMessageCount",
          kind: "evidenceField",
        },
        {
          equals: "failed",
          field: "$.recovery.staleRunStatus",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.recovery.preemptCalls",
          kind: "evidenceField",
        },
      ],
      capabilities: ["framework.run-liveness"],
      checkId:
        "runtime-lifecycle-ext.stale-recovery.signal-mismatch-fresh-turn",
      evidence: [
        "recovery.sameTurn",
        "recovery.originalUserMessageCount",
        "recovery.freshUserMessageCount",
        "recovery.staleRunStatus",
        "recovery.preemptCalls",
      ],
      input: { scenarioPath: "$.stale-recovery-signal-mismatch" },
      operation: "runtime.recover-stale-run",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.recovery.sameTurn",
          kind: "evidenceField",
        },
        {
          equals: "completed",
          field: "$.recovery.phase",
          kind: "evidenceField",
        },
        {
          equals: "reviewer",
          field: "$.recovery.activeAgent",
          kind: "evidenceField",
        },
        {
          equals: "reviewer",
          field: "$.recovery.branchStatusActiveAgent",
          kind: "evidenceField",
        },
        {
          equals: "failed",
          field: "$.recovery.staleRunStatus",
          kind: "evidenceField",
        },
      ],
      capabilities: ["framework.run-liveness"],
      checkId:
        "runtime-lifecycle-ext.stale-recovery.handoff-context-active-agent",
      evidence: [
        "recovery.sameTurn",
        "recovery.phase",
        "recovery.activeAgent",
        "recovery.branchStatusActiveAgent",
        "recovery.staleRunStatus",
      ],
      input: { scenarioPath: "$.stale-recovery-handoff-context" },
      operation: "runtime.recover-stale-run",
      scenario: "runtime-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.recovery.sameTurn",
          kind: "evidenceField",
        },
        {
          equals: "completed",
          field: "$.recovery.phase",
          kind: "evidenceField",
        },
        {
          equals: 0,
          field: "$.recovery.driverExecuteCalls",
          kind: "evidenceField",
        },
        {
          equals: "completed",
          field: "$.recovery.branchRuntimePhase",
          kind: "evidenceField",
        },
        {
          equals: "failed",
          field: "$.recovery.staleRunStatus",
          kind: "evidenceField",
        },
      ],
      capabilities: ["framework.run-liveness"],
      checkId: "runtime-lifecycle-ext.stale-recovery.finalize-terminal-status",
      evidence: [
        "recovery.sameTurn",
        "recovery.phase",
        "recovery.driverExecuteCalls",
        "recovery.branchRuntimePhase",
        "recovery.staleRunStatus",
      ],
      input: { scenarioPath: "$.stale-recovery-finalize-status" },
      operation: "runtime.recover-stale-run",
      scenario: "runtime-api-scenarios",
    }
  );

  return {
    applicability: { capabilities: ["framework.runtime-api"] },
    checks: checks.map(normalizeGeneratedResultSurfaceCheck),
    packetId: "tuvren.framework.runtime-api",
    planId: "tuvren.framework.runtime-api.lifecycle-extended",
    planVersion: "0.1.0",
    scenarios: {
      "runtime-api-scenarios": "../scenarios/runtime-api-scenarios.json",
    },
  };
}

// Event-stream extended — granular assertions on the SSE/AGUI projections for
// each scenario, including event-by-event ordering and frame-payload checks.
function buildEventStreamExtended(): Plan {
  const checks: PlanCheck[] = [];
  const sseProjection = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[],
    scenarioPath: string
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `event-stream-ext.sse.${id}`,
    evidence,
    input: { scenarioPath },
    operation: "event-stream.runtime-sse-projection",
    scenario: "event-stream-scenarios",
  });
  checks.push(
    sseProjection(
      "completed-turn-frame-events-include-state-snapshot",
      {
        contains: "state.snapshot",
        field: "$.frameEvents",
        kind: "evidenceField",
      },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-include-iteration-start",
      {
        contains: "iteration.start",
        field: "$.frameEvents",
        kind: "evidenceField",
      },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-include-tool-result",
      {
        contains: "tool.result",
        field: "$.frameEvents",
        kind: "evidenceField",
      },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-include-text-delta",
      { contains: "text.delta", field: "$.frameEvents", kind: "evidenceField" },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-source-event-types-start-with-turn-start",
      {
        equals: "turn.start",
        field: "$.sourceEventTypes.0",
        kind: "evidenceField",
      },
      ["sourceEventTypes.0"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-end-with-turn-end",
      {
        equals: "turn.end",
        field: "$.frameEvents.23",
        kind: "evidenceField",
      },
      ["frameEvents.23"],
      "$.completed-tool-turn"
    ),
    // Ordering kind works against context.events (runner-collected from the
    // events() channel). Frame events live inside evidence, so we approximate
    // ordering with a pair of value-containment assertions per scenario.
    sseProjection(
      "completed-turn-frame-events-contain-turn-start",
      { contains: "turn.start", field: "$.frameEvents", kind: "evidenceField" },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-contain-turn-end",
      { contains: "turn.end", field: "$.frameEvents", kind: "evidenceField" },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-contain-tool-call-start",
      {
        contains: "tool_call.start",
        field: "$.frameEvents",
        kind: "evidenceField",
      },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-frame-events-contain-iteration-end",
      {
        contains: "iteration.end",
        field: "$.frameEvents",
        kind: "evidenceField",
      },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "completed-turn-no-error-event",
      { eventType: "error", kind: "noEvent" },
      ["frameEvents"],
      "$.completed-tool-turn"
    ),
    sseProjection(
      "failed-provider-turn-frame-events-include-error",
      { contains: "error", field: "$.frameEvents", kind: "evidenceField" },
      ["frameEvents"],
      "$.failed-provider-turn"
    ),
    sseProjection(
      "paused-approval-turn-source-events-include-approval-requested",
      {
        contains: "approval.requested",
        field: "$.sourceEventTypes",
        kind: "evidenceField",
      },
      ["sourceEventTypes"],
      "$.paused-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-source-events-include-approval-requested",
      {
        contains: "approval.requested",
        field: "$.sourceEventTypes",
        kind: "evidenceField",
      },
      ["sourceEventTypes"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-source-events-include-approval-resolved",
      {
        contains: "approval.resolved",
        field: "$.sourceEventTypes",
        kind: "evidenceField",
      },
      ["sourceEventTypes"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-frame-events-contain-turn-end",
      {
        contains: "turn.end",
        field: "$.frameEvents",
        kind: "evidenceField",
      },
      ["frameEvents"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-thread-id-present",
      { field: "$.threadIds.0", kind: "evidenceField" },
      ["threadIds.0"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-source-thread-id-present",
      { field: "$.sourceThreadIds.0", kind: "evidenceField" },
      ["sourceThreadIds.0"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-checkpoint-hash-format",
      {
        field: "$.checkpointHashes.0",
        kind: "evidenceField",
        matches: "^[a-f0-9]{64}$",
      },
      ["checkpointHashes.0"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-resumed-from-hash-format",
      {
        field: "$.resumedFromHashes.0",
        kind: "evidenceField",
        matches: "^[a-f0-9]{64}$",
      },
      ["resumedFromHashes.0"],
      "$.resumed-approval-turn"
    ),
    sseProjection(
      "resumed-approval-turn-source-events-include-text-delta",
      {
        contains: "text.delta",
        field: "$.sourceEventTypes",
        kind: "evidenceField",
      },
      ["sourceEventTypes"],
      "$.resumed-approval-turn"
    )
  );

  // SSE eager subscription
  const sseEager = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[],
    scenarioPath: string
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `event-stream-ext.sse-eager.${id}`,
    evidence,
    input: { scenarioPath },
    operation: "event-stream.runtime-sse-eager-subscription",
    scenario: "event-stream-scenarios",
  });
  checks.push(
    sseEager(
      "first-direct-event-turn-start",
      {
        equals: "turn.start",
        field: "$.firstDirectEventType",
        kind: "evidenceField",
      },
      ["firstDirectEventType"],
      "$.completed-tool-turn"
    ),
    sseEager(
      "first-frame-event-turn-start",
      {
        equals: "turn.start",
        field: "$.firstFrameEvent",
        kind: "evidenceField",
      },
      ["firstFrameEvent"],
      "$.completed-tool-turn"
    ),
    sseEager(
      "failed-turn-first-direct-event-turn-start",
      {
        equals: "turn.start",
        field: "$.firstDirectEventType",
        kind: "evidenceField",
      },
      ["firstDirectEventType"],
      "$.failed-provider-turn"
    ),
    sseEager(
      "paused-turn-first-frame-event-turn-start",
      {
        equals: "turn.start",
        field: "$.firstFrameEvent",
        kind: "evidenceField",
      },
      ["firstFrameEvent"],
      "$.paused-approval-turn"
    )
  );

  // AGUI projection
  const agui = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[],
    scenarioPath: string
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `event-stream-ext.agui.${id}`,
    evidence,
    input: { scenarioPath },
    operation: "event-stream.runtime-agui-projection",
    scenario: "event-stream-scenarios",
  });
  checks.push(
    agui(
      "completed-turn-event-types-include-run-started",
      { contains: "RUN_STARTED", field: "$.eventTypes", kind: "evidenceField" },
      ["eventTypes"],
      "$.completed-tool-turn"
    ),
    agui(
      "completed-turn-event-types-include-run-finished",
      {
        contains: "RUN_FINISHED",
        field: "$.eventTypes",
        kind: "evidenceField",
      },
      ["eventTypes"],
      "$.completed-tool-turn"
    ),
    agui(
      "completed-turn-event-types-include-state-snapshot",
      {
        contains: "STATE_SNAPSHOT",
        field: "$.eventTypes",
        kind: "evidenceField",
      },
      ["eventTypes"],
      "$.completed-tool-turn"
    ),
    agui(
      "completed-turn-event-types-include-tool-call-start",
      {
        contains: "TOOL_CALL_START",
        field: "$.eventTypes",
        kind: "evidenceField",
      },
      ["eventTypes"],
      "$.completed-tool-turn"
    ),
    agui(
      "completed-turn-event-types-include-tool-call-result",
      {
        contains: "TOOL_CALL_RESULT",
        field: "$.eventTypes",
        kind: "evidenceField",
      },
      ["eventTypes"],
      "$.completed-tool-turn"
    ),
    agui(
      "completed-turn-event-types-include-text-message-start",
      {
        contains: "TEXT_MESSAGE_START",
        field: "$.eventTypes",
        kind: "evidenceField",
      },
      ["eventTypes"],
      "$.completed-tool-turn"
    ),
    {
      assertions: [
        {
          contains: "RUN_STARTED",
          field: "$.eventTypes",
          kind: "evidenceField",
        },
        {
          contains: "RUN_FINISHED",
          field: "$.eventTypes",
          kind: "evidenceField",
        },
      ],
      checkId:
        "event-stream-ext.agui.completed-turn-event-types-include-run-started-and-finished",
      evidence: ["eventTypes"],
      input: { scenarioPath: "$.completed-tool-turn" },
      operation: "event-stream.runtime-agui-projection",
      scenario: "event-stream-scenarios",
    },
    agui(
      "completed-turn-warnings-include-checkpoint-fallback",
      {
        contains: "agui_state_checkpoint_custom_fallback",
        field: "$.warningCodes",
        kind: "evidenceField",
      },
      ["warningCodes"],
      "$.completed-tool-turn"
    ),
    agui(
      "failed-turn-event-types-end-with-run-error",
      { equals: "RUN_ERROR", field: "$.eventTypes.8", kind: "evidenceField" },
      ["eventTypes.8"],
      "$.failed-provider-turn"
    ),
    agui(
      "failed-turn-error-code-snake-case",
      {
        field: "$.events.8.rawEvent.error.code",
        kind: "evidenceField",
        matches: "^[a-z0-9]+(?:_[a-z0-9]+)*$",
      },
      ["events.8.rawEvent.error.code"],
      "$.failed-provider-turn"
    ),
    agui(
      "paused-turn-warnings-include-paused-coercion",
      {
        contains: "agui_paused_turn_coerced_to_run_finished",
        field: "$.warningCodes",
        kind: "evidenceField",
      },
      ["warningCodes"],
      "$.paused-approval-turn"
    )
  );

  // Per-frame index assertions for the completed-tool-turn scenario. This
  // pins the SSE projection ordering one event at a time so that adapters
  // emitting events in a different order light up the offending index.
  const completedToolTurnFrameSequence: readonly string[] = [
    "turn.start",
    "state.checkpoint",
    "state.snapshot",
    "iteration.start",
    "message.start",
    "tool_call.start",
    "tool_call.args_delta",
    "tool_call.done",
    "message.done",
    "tool.start",
    "tool.result",
    "state.checkpoint",
    "state.snapshot",
    "iteration.end",
    "iteration.start",
    "message.start",
    "text.delta",
    "text.done",
    "message.done",
    "state.checkpoint",
    "state.snapshot",
    "iteration.end",
    "state.checkpoint",
    "turn.end",
  ];
  for (const [
    index,
    expectedType,
  ] of completedToolTurnFrameSequence.entries()) {
    checks.push(
      sseProjection(
        `completed-turn-frame-event-${index.toString().padStart(2, "0")}`,
        {
          equals: expectedType,
          field: `$.frameEvents.${index}`,
          kind: "evidenceField",
        },
        [`frameEvents.${index}`],
        "$.completed-tool-turn"
      )
    );
  }

  // Per-AGUI-event assertions for the completed-tool-turn scenario.
  const completedToolTurnAguiSequence: readonly string[] = [
    "RUN_STARTED",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_STARTED",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "CUSTOM",
    "CUSTOM",
    "TOOL_CALL_RESULT",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_FINISHED",
    "STEP_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "CUSTOM",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_FINISHED",
    "CUSTOM",
    "RUN_FINISHED",
  ];
  for (const [index, expectedType] of completedToolTurnAguiSequence.entries()) {
    checks.push(
      agui(
        `completed-turn-event-${index.toString().padStart(2, "0")}`,
        {
          equals: expectedType,
          field: `$.eventTypes.${index}`,
          kind: "evidenceField",
        },
        [`eventTypes.${index}`],
        "$.completed-tool-turn"
      )
    );
  }

  // Per-AGUI-event assertions for the failed-provider-turn scenario.
  const failedProviderAguiSequence: readonly string[] = [
    "RUN_STARTED",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_STARTED",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_FINISHED",
    "CUSTOM",
    "RUN_ERROR",
  ];
  for (const [index, expectedType] of failedProviderAguiSequence.entries()) {
    checks.push(
      agui(
        `failed-turn-event-${index.toString().padStart(2, "0")}`,
        {
          equals: expectedType,
          field: `$.eventTypes.${index}`,
          kind: "evidenceField",
        },
        [`eventTypes.${index}`],
        "$.failed-provider-turn"
      )
    );
  }

  // Per-AGUI-event assertions for the paused-approval-turn scenario.
  const pausedApprovalAguiSequence: readonly string[] = [
    "RUN_STARTED",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_STARTED",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "CUSTOM",
    "CUSTOM",
    "STATE_SNAPSHOT",
    "STEP_FINISHED",
    "CUSTOM",
    "CUSTOM",
    "RUN_FINISHED",
  ];
  for (const [index, expectedType] of pausedApprovalAguiSequence.entries()) {
    checks.push(
      agui(
        `paused-turn-event-${index.toString().padStart(2, "0")}`,
        {
          equals: expectedType,
          field: `$.eventTypes.${index}`,
          kind: "evidenceField",
        },
        [`eventTypes.${index}`],
        "$.paused-approval-turn"
      )
    );
  }

  // Per-source-event index probes were removed: the original sequences I
  // wrote omitted state.snapshot entries the runtime actually emits, so the
  // checks produced false failures. Re-introduce them only with sequences
  // observed from the canonical reference adapter.

  return {
    applicability: { capabilities: ["framework.event-stream"] },
    checks: checks.map(normalizeGeneratedEventStreamCheck),
    packetId: "tuvren.framework.event-stream",
    planId: "tuvren.framework.event-stream.extended",
    planVersion: "0.1.0",
    scenarios: {
      "event-stream-scenarios": "../scenarios/event-stream-scenarios.json",
    },
  };
}

function normalizeGeneratedEventStreamCheck(check: PlanCheck): PlanCheck {
  const assertions = check.assertions.map((assertion) =>
    normalizeGeneratedEventStreamAssertion(check.operation, assertion)
  );
  const { evidence: _evidence, ...rest } = check;

  return {
    ...rest,
    assertions,
    ...(assertions.some(
      (assertion) =>
        assertion.kind === "eventSequence" ||
        assertion.kind === "noEvent" ||
        assertion.kind === "ordering"
    )
      ? { evidence: ["events"] }
      : {}),
  };
}

function normalizeGeneratedEventStreamAssertion(
  operation: string,
  assertion: Record<string, unknown>
): Record<string, unknown> {
  if (
    assertion.kind === "noEvent" &&
    operation === "event-stream.runtime-sse-projection"
  ) {
    return {
      ...assertion,
      path: "$.event",
    };
  }

  const field =
    typeof assertion.field === "string" ? assertion.field : undefined;

  if (field === undefined) {
    return assertion;
  }

  return (
    normalizeEventStreamEagerAssertion(operation, assertion, field) ??
    normalizeEventStreamSseAssertion(operation, assertion, field) ??
    normalizeEventStreamAguiAssertion(operation, assertion, field) ??
    normalizeEventStreamResultNamespaceAssertion(operation, assertion, field) ??
    assertion
  );
}

function omitField(
  assertion: Record<string, unknown>
): Record<string, unknown> {
  const { field: _field, ...rest } = assertion;
  return rest;
}

function normalizeEventStreamEagerAssertion(
  operation: string,
  assertion: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  if (operation !== "event-stream.runtime-sse-eager-subscription") {
    return undefined;
  }

  if (field === "$.firstDirectEventType") {
    return toResultFieldAssertion(assertion, "$.firstDirectEvent.type");
  }

  if (field === "$.firstFrameEvent") {
    return toResultFieldAssertion(assertion, "$.events.0.event");
  }

  return normalizeEventStreamResultNamespaceAssertion(
    operation,
    assertion,
    field
  );
}

function normalizeEventStreamSseAssertion(
  operation: string,
  assertion: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  if (operation !== "event-stream.runtime-sse-projection") {
    return undefined;
  }

  if (field === "$.frameEvents") {
    return {
      ...omitField(assertion),
      kind: "eventSequence",
      path: "$.event",
    };
  }

  if (field.startsWith("$.frameEvents.")) {
    return toResultFieldAssertion(
      assertion,
      `${field.replace("$.frameEvents.", "$.events.")}.event`
    );
  }

  if (field === "$.framePayloads.10.output.source") {
    return toResultFieldAssertion(
      assertion,
      "$.events.10.payload.output.source"
    );
  }

  if (field === "$.sourceEventTypes.0") {
    return toResultFieldAssertion(assertion, "$.events.0.payload.type");
  }

  if (field === "$.sourceEventTypes") {
    return {
      ...omitField(assertion),
      kind: "eventSequence",
      path: "$.payload.type",
    };
  }

  if (field === "$.threadIds.0") {
    return toResultFieldAssertion(assertion, "$.events.0.payload.threadId");
  }

  if (field === "$.sourceThreadIds.0") {
    return toResultFieldAssertion(
      assertion,
      "$.events.0.payload.source.threadId"
    );
  }

  if (field === "$.checkpointHashes.0") {
    return toResultFieldAssertion(assertion, "$.events.1.payload.turnNodeHash");
  }

  if (field === "$.resumedFromHashes.0") {
    return toResultFieldAssertion(assertion, "$.events.14.payload.resumedFrom");
  }

  return normalizeEventStreamResultNamespaceAssertion(
    operation,
    assertion,
    field
  );
}

function normalizeEventStreamAguiAssertion(
  operation: string,
  assertion: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  if (operation !== "event-stream.runtime-agui-projection") {
    return undefined;
  }

  if (field === "$.eventTypes") {
    return {
      ...omitField(assertion),
      kind: "eventSequence",
      path: "$.type",
    };
  }

  if (field.startsWith("$.eventTypes.")) {
    return toResultFieldAssertion(
      assertion,
      `${field.replace("$.eventTypes.", "$.events.")}.type`
    );
  }

  if (field === "$.sourceEventTypes.0") {
    return toResultFieldAssertion(assertion, "$.events.0.rawEvent.type");
  }

  if (field === "$.sourceEventTypes") {
    return {
      ...omitField(assertion),
      kind: "eventSequence",
      path: "$.rawEvent.type",
    };
  }

  if (field === "$.warningCodes") {
    return {
      ...toResultFieldAssertion(assertion, "$.warnings"),
      ...(assertion.equals === undefined
        ? {}
        : { equals: mapWarningExpectation(assertion.equals) }),
      ...(assertion.contains === undefined
        ? {}
        : { contains: mapWarningExpectation(assertion.contains) }),
    };
  }

  return normalizeEventStreamResultNamespaceAssertion(
    operation,
    assertion,
    field
  );
}

function normalizeEventStreamResultNamespaceAssertion(
  operation: string,
  assertion: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  if (
    operation !== "event-stream.runtime-sse-projection" &&
    operation !== "event-stream.runtime-sse-eager-subscription" &&
    operation !== "event-stream.runtime-agui-projection"
  ) {
    return undefined;
  }

  if (
    field === "$.warnings" ||
    field.startsWith("$.warnings.") ||
    field === "$.firstDirectEvent" ||
    field.startsWith("$.firstDirectEvent.") ||
    field === "$.events" ||
    field.startsWith("$.events.")
  ) {
    return toResultFieldAssertion(assertion, field);
  }

  return undefined;
}

function toResultFieldAssertion(
  assertion: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  return {
    ...assertion,
    field,
    kind: "resultField",
  };
}

function mapWarningExpectation(value: unknown): unknown {
  if (typeof value === "string") {
    return { code: value };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => mapWarningExpectation(entry));
  }

  return value;
}

function normalizeGeneratedResultSurfaceCheck(check: PlanCheck): PlanCheck {
  const assertions = check.assertions.map((assertion) =>
    normalizeGeneratedResultSurfaceAssertion(assertion)
  );
  const transformed = assertions.some(
    (assertion, index) => assertion !== check.assertions[index]
  );

  if (!transformed) {
    return check;
  }

  const { evidence, ...rest } = check;

  return {
    ...rest,
    assertions,
    ...(evidence === undefined
      ? {}
      : {
          evidence: isAfPromotedCheck(check.checkId)
            ? evidence
            : evidence.map(normalizeGeneratedResultRequiredEvidencePath),
        }),
  };
}

function normalizeGeneratedResultSurfaceAssertion(
  assertion: Record<string, unknown>
): Record<string, unknown> {
  if (assertion.kind === "evidenceField") {
    return toResultFieldAssertion(assertion, String(assertion.field));
  }

  if (
    assertion.kind === "schemaValid" &&
    typeof assertion.path === "string" &&
    (assertion.path === "$.evidence" ||
      assertion.path.startsWith("$.evidence."))
  ) {
    return {
      ...assertion,
      path: assertion.path.replace("$.evidence", "$.result"),
    };
  }

  return assertion;
}

function normalizeGeneratedResultRequiredEvidencePath(path: string): string {
  if (
    path === "result" ||
    path.startsWith("result.") ||
    path === "state" ||
    path.startsWith("state.") ||
    path === "trace" ||
    path.startsWith("trace.")
  ) {
    return path;
  }

  return `result.${path}`;
}

function isAfPromotedCheck(checkId: string): boolean {
  return (
    checkId.startsWith("driver-api-af.") ||
    checkId.startsWith("react-driver-af.") ||
    checkId.startsWith("runtime-callable-af.") ||
    checkId.startsWith("runtime-lifecycle-af.") ||
    checkId.startsWith("runtime-orchestration-af.") ||
    // KRT-AL002 G1 relocated tool/approval AF checks from
    // `runtime-callable-af.*` to `tool-contracts-af.*` (now owned by the
    // tool-contracts authority packet). The normalizer must treat them as
    // promoted-AF so their evidence paths stay untouched.
    checkId.startsWith("tool-contracts-af.")
  );
}

// Driver API extended — broader assertions on driver.execute and driver.resume
// resolution shapes using operations declared by the driver authority packet.
function buildDriverApiExtended(): Plan {
  const checks: PlanCheck[] = [];

  const driverExecute = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[],
    scenarioPath: string
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `driver-api-ext.execute.${id}`,
    evidence,
    input: { scenarioPath },
    operation: "driver.execute",
    scenario: "driver-api-scenarios",
  });
  checks.push(
    driverExecute(
      "hook-turn-phase-completed",
      { equals: "completed", field: "$.driver.phase", kind: "evidenceField" },
      ["driver.phase"],
      "$.driver-hook-turn"
    ),
    driverExecute(
      "hook-turn-phase-string",
      {
        field: "$.driver.phase",
        kind: "evidenceField",
        matches: "^(running|paused|completed|failed)$",
      },
      ["driver.phase"],
      "$.driver-hook-turn"
    ),
    driverExecute(
      "provider-failure-error-envelope",
      { kind: "errorEnvelope", path: "$.result.error" },
      ["result.error.code"],
      "$.driver-provider-failure"
    ),
    {
      assertions: [
        {
          equals: "fail",
          field: "$.driver.resolutionType",
          kind: "evidenceField",
        },
        {
          equals: "invalid_loop_policy",
          field: "$.driver.errorCode",
          kind: "evidenceField",
        },
        { kind: "errorEnvelope", path: "$.result.error" },
      ],
      checkId: "driver-api-af.invalid-loop-policy-tool-call-hard-fail",
      evidence: ["driver.resolutionType", "result.error.code"],
      input: { scenarioPath: "$.driver-invalid-loop-policy-tool-call" },
      operation: "driver.execute",
      scenario: "driver-api-scenarios",
    }
    // Snake-case-shape and non-empty-message probes were removed: evidenceField
    // reads context.evidence, but the error envelope lives at context.result —
    // those checks always failed regardless of adapter correctness. The
    // errorEnvelope assertion above already validates structural shape.
  );

  const driverResume = (
    id: string,
    assertion: Record<string, unknown>,
    evidence: string[],
    scenarioPath: string
  ): PlanCheck => ({
    assertions: [assertion],
    checkId: `driver-api-ext.resume.${id}`,
    evidence,
    input: { scenarioPath },
    operation: "driver.resume",
    scenario: "driver-api-scenarios",
  });
  checks.push(
    driverResume(
      "approval-resolution-end-turn",
      {
        equals: "end_turn",
        field: "$.driver.resolutionType",
        kind: "evidenceField",
      },
      ["driver.resolutionType"],
      "$.driver-resume-approval"
    ),
    driverResume(
      "approval-pending-call-id-list-non-empty",
      {
        contains: "call-search",
        field: "$.driver.pendingToolCallIds",
        kind: "evidenceField",
      },
      ["driver.pendingToolCallIds"],
      "$.driver-resume-approval"
    ),
    driverResume(
      "approval-decision-call-id-includes-call-search",
      {
        contains: "call-search",
        field: "$.driver.approvalDecisionCallIds",
        kind: "evidenceField",
      },
      ["driver.approvalDecisionCallIds"],
      "$.driver-resume-approval"
    ),
    driverResume(
      "missing-pending-call-resolution-fail",
      {
        equals: "fail",
        field: "$.driver.resolutionType",
        kind: "evidenceField",
      },
      ["driver.resolutionType"],
      "$.driver-resume-missing-pending-call"
    ),
    driverResume(
      "missing-pending-call-error-envelope",
      { kind: "errorEnvelope", path: "$.result.error" },
      ["result.error.code"],
      "$.driver-resume-missing-pending-call"
    )
  );

  // Forward-looking probes against driver operations not declared by the
  // driver-api TypeSpec source were removed (validate-plans rejects them).
  // Bringing those operations under authority is a separate spec amendment.

  return {
    applicability: { capabilities: ["framework.driver-api"] },
    checks: checks.map(normalizeGeneratedResultSurfaceCheck),
    packetId: "tuvren.framework.driver-api",
    planId: "tuvren.framework.driver-api.extended",
    planVersion: "0.1.0",
    scenarios: {
      "driver-api-scenarios": "../scenarios/driver-api-scenarios.json",
    },
  };
}

// React-driver extended — broader hook-count and checkpoint-shape coverage
// against the existing driver.execute and driver.checkpoint operations.
function buildReactDriverExtended(): Plan {
  const checks: PlanCheck[] = [];

  const hookCheck = (
    id: string,
    field: string,
    expected: number
  ): PlanCheck => ({
    assertions: [
      { equals: expected, field: `$.${field}`, kind: "evidenceField" },
    ],
    checkId: `react-driver-ext.${id}`,
    evidence: [field],
    input: { scenarioPath: "$.driver-hook-turn" },
    operation: "driver.execute",
    scenario: "driver-api-scenarios",
  });
  checks.push(
    hookCheck("before-iteration-twice", "hooks.beforeIteration", 2),
    hookCheck("around-model-twice", "hooks.aroundModel", 2),
    hookCheck("after-iteration-twice", "hooks.afterIteration", 2),
    hookCheck("around-tool-once", "hooks.aroundTool", 1),
    {
      assertions: [
        {
          equals: [
            "beforeIteration",
            "aroundModel.before",
            "aroundModel.after",
            "aroundTool.before",
            "aroundTool.after",
            "afterIteration",
            "beforeIteration",
            "aroundModel.before",
            "aroundModel.after",
            "afterIteration",
          ],
          field: "$.hooks.phaseTrace",
          kind: "evidenceField",
        },
      ],
      checkId: "react-driver-af.extension.phase-order-before-around-after",
      evidence: ["hooks.phaseTrace"],
      input: { scenarioPath: "$.driver-hook-turn" },
      operation: "driver.execute",
      scenario: "driver-api-scenarios",
    },
    {
      assertions: [
        {
          equals: ["aroundTool.before", "tool.execute", "aroundTool.after"],
          field: "$.hooks.aroundToolTrace",
          kind: "evidenceField",
        },
      ],
      checkId: "react-driver-af.extension.around-tool-nesting",
      evidence: ["hooks.aroundToolTrace"],
      input: { scenarioPath: "$.driver-hook-turn" },
      operation: "driver.execute",
      scenario: "driver-api-scenarios",
    },
    {
      assertions: [
        {
          equals: true,
          field: "$.hooks.terminalMutationAttempted",
          kind: "evidenceField",
        },
        {
          equals: "driver hook turn completed",
          field: "$.hooks.terminalMutationDurableText",
          kind: "evidenceField",
        },
      ],
      checkId:
        "react-driver-af.extension.after-iteration-terminal-state-nondurable",
      evidence: [
        "hooks.terminalMutationAttempted",
        "hooks.terminalMutationDurableText",
      ],
      input: { scenarioPath: "$.driver-hook-turn" },
      operation: "driver.execute",
      scenario: "driver-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "modified",
          field: "$.aroundModel.finalAssistantText",
          kind: "evidenceField",
        },
        {
          equals: 1,
          field: "$.aroundModel.messageStartCount",
          kind: "evidenceField",
        },
        {
          equals: ["provider"],
          field: "$.aroundModel.streamedTextDone",
          kind: "evidenceField",
        },
      ],
      checkId: "react-driver-af.around-model-post-stream-replacement",
      evidence: [
        "aroundModel.finalAssistantText",
        "aroundModel.messageStartCount",
        "aroundModel.streamedTextDone",
      ],
      input: { scenarioPath: "$.driver-around-model-post-stream-replacement" },
      operation: "driver.execute",
      scenario: "driver-api-scenarios",
    },
    {
      assertions: [
        {
          equals: "second attempt",
          field: "$.aroundModel.finalAssistantText",
          kind: "evidenceField",
        },
        {
          equals: 2,
          field: "$.provider.generate.callCount",
          kind: "evidenceField",
        },
      ],
      checkId: "react-driver-af.around-model-retry-final-response-durable",
      evidence: [
        "aroundModel.finalAssistantText",
        "provider.generate.callCount",
      ],
      input: { scenarioPath: "$.driver-around-model-retry-final-response" },
      operation: "driver.execute",
      scenario: "driver-api-scenarios",
    }
  );

  // Hook ordering: assert that beforeIteration hits at least 1 and afterIteration matches.
  const hookFieldExists = (id: string, field: string): PlanCheck => ({
    assertions: [{ field: `$.${field}`, kind: "evidenceField" }],
    checkId: `react-driver-ext.hook-field-present.${id}`,
    evidence: [field],
    input: { scenarioPath: "$.driver-hook-turn" },
    operation: "driver.execute",
    scenario: "driver-api-scenarios",
  });
  checks.push(
    hookFieldExists("before-iteration-present", "hooks.beforeIteration"),
    hookFieldExists("after-iteration-present", "hooks.afterIteration"),
    hookFieldExists("around-model-present", "hooks.aroundModel"),
    hookFieldExists("around-tool-present", "hooks.aroundTool")
  );

  // Checkpoint trace
  checks.push({
    assertions: [
      {
        equals: 4,
        field: "$.trace.checkpoint.evidence.checkpoint.manifestPathCount",
        kind: "stateField",
      },
    ],
    checkId: "react-driver-ext.checkpoint-manifest-path-count",
    evidence: ["trace.checkpoint.evidence.checkpoint.manifestPathCount"],
    input: { scenarioPath: "$.driver-checkpoint-turn" },
    operation: "driver.checkpoint",
    scenario: "driver-api-scenarios",
    steps: [
      {
        input: { scenarioPath: "$.driver-checkpoint-turn" },
        operation: "driver.checkpoint",
        stepId: "checkpoint",
      },
    ],
  } as PlanCheck);

  // Forward-looking probes against react-driver concepts not declared by
  // driver-api TypeSpec were removed (validate-plans rejects them).

  return {
    applicability: { capabilities: ["framework.react-driver"] },
    checks: checks.map(normalizeGeneratedResultSurfaceCheck),
    packetId: "tuvren.framework.react-driver",
    planId: "tuvren.framework.react-driver.extended",
    planVersion: "0.1.0",
    scenarios: {
      "driver-api-scenarios": "../scenarios/driver-api-scenarios.json",
    },
  };
}
