/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventSchemas, EventType } from "@ag-ui/core";
import {
  collectStreamValues,
  createFixtureEventStream,
  frameworkStreamTestFixtures,
  waitForAsyncTurn,
} from "@tuvren/framework-testkit";
import { toAgUiEvents } from "@tuvren/stream-agui";
import { teeTuvrenStreamEvents } from "@tuvren/stream-core";
import { toSseFrames } from "@tuvren/stream-sse";
import {
  type ConformanceCheckResult,
  type ConformanceEvidence,
  createAssertionResult,
  createCheckResult,
  createConformanceEvidenceSummary,
} from "../../../../../../tools/scripts/lib/conformance-contract.js";
import {
  emitConformanceEvidence,
  readConformanceSuiteManifest,
  selectImplementationChecks,
} from "../../../../../../tools/scripts/lib/conformance-runner.js";

const FRAMEWORK_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../conformance/scenarios/suite-manifest.json"
);
const IMPLEMENTATION_ID = "typescript-framework";
const LANGUAGE = "typescript";

await main();

async function main(): Promise<void> {
  const manifest = await readConformanceSuiteManifest(FRAMEWORK_MANIFEST_PATH);
  const checkResults: ConformanceCheckResult[] = [];

  for (const check of selectImplementationChecks(manifest, IMPLEMENTATION_ID)) {
    checkResults.push(await runCheck(check.checkId));
  }

  const summary = createConformanceEvidenceSummary(checkResults);
  const evidence: ConformanceEvidence = {
    boundary: manifest.boundary,
    checkResults,
    implementationId: IMPLEMENTATION_ID,
    language: LANGUAGE,
    status: summary.failedChecks === 0 ? "pass" : "fail",
    suiteId: manifest.suiteId,
    suiteVersion: manifest.suiteVersion,
    summary,
  };

  emitConformanceEvidence(evidence);
}

function runCheck(checkId: string): Promise<ConformanceCheckResult> {
  switch (checkId) {
    case "framework.stream.completed_turn_sequence":
      return Promise.resolve(createCompletedTurnSequenceCheck());
    case "framework.stream.failed_turn_terminal_error":
      return Promise.resolve(createFailedTurnCheck());
    case "framework.stream.paused_turn_approval_shape":
      return Promise.resolve(createPausedTurnCheck());
    case "framework.stream.sse_projection":
      return createSseProjectionCheck();
    case "framework.stream.sse_eager_subscription":
      return createSseEagerSubscriptionCheck();
    case "framework.stream.agui_projection":
      return createAgUiProjectionCheck();
    case "framework.stream.agui_failed_turn_error_projection":
      return createAgUiFailedTurnCheck();
    case "framework.stream.agui_paused_turn_fallback":
      return createAgUiPausedTurnCheck();
    default:
      throw new Error(`unsupported framework conformance check ${checkId}`);
  }
}

function createCompletedTurnSequenceCheck(): ConformanceCheckResult {
  const eventTypes = frameworkStreamTestFixtures.completedTurn.map(
    (event) => event.type
  );
  const argsDeltaEvent = frameworkStreamTestFixtures.completedTurn[6];
  const manifestEvent = frameworkStreamTestFixtures.completedTurn[10];

  return createCheckResult(
    "framework.stream.completed_turn_sequence",
    [
      createAssertionResult(
        "completed_turn_event_order",
        arraysAreEqual(eventTypes, [
          "turn.start",
          "iteration.start",
          "message.start",
          "text.delta",
          "text.done",
          "tool_call.start",
          "tool_call.args_delta",
          "tool_call.done",
          "tool.start",
          "tool.result",
          "state.snapshot",
          "custom",
          "message.done",
          "iteration.end",
          "turn.end",
        ])
      ),
      createAssertionResult(
        "completed_turn_tool_args_delta",
        argsDeltaEvent?.type === "tool_call.args_delta" &&
          argsDeltaEvent.delta === '{"query":"docs"}'
      ),
      createAssertionResult(
        "completed_turn_manifest_snapshot",
        manifestEvent?.type === "state.snapshot" &&
          manifestEvent.manifest.messageCount === 3 &&
          manifestEvent.manifest.toolCalls.total === 1
      ),
    ],
    {
      eventTypes,
    }
  );
}

function createFailedTurnCheck(): ConformanceCheckResult {
  const errorEvent = frameworkStreamTestFixtures.failedTurn.find(
    (event) => event.type === "error"
  );
  const terminalEvent = frameworkStreamTestFixtures.failedTurn.at(-1);

  return createCheckResult(
    "framework.stream.failed_turn_terminal_error",
    [
      createAssertionResult(
        "failed_turn_has_error_event",
        errorEvent !== undefined
      ),
      createAssertionResult(
        "failed_turn_has_failed_status",
        terminalEvent?.type === "turn.end" && terminalEvent.status === "failed"
      ),
    ],
    {
      failedStatus:
        terminalEvent?.type === "turn.end" ? terminalEvent.status : undefined,
    }
  );
}

function createPausedTurnCheck(): ConformanceCheckResult {
  const approvalEvent = frameworkStreamTestFixtures.pausedTurn[1];
  const terminalEvent = frameworkStreamTestFixtures.pausedTurn.at(-1);

  return createCheckResult(
    "framework.stream.paused_turn_approval_shape",
    [
      createAssertionResult(
        "paused_turn_has_approval_request",
        approvalEvent?.type === "approval.requested" &&
          approvalEvent.request.toolCalls[0]?.name === "send_email"
      ),
      createAssertionResult(
        "paused_turn_has_paused_status",
        terminalEvent?.type === "turn.end" && terminalEvent.status === "paused"
      ),
    ],
    {
      approvalNames:
        approvalEvent?.type === "approval.requested"
          ? approvalEvent.request.toolCalls.map((toolCall) => toolCall.name)
          : [],
    }
  );
}

async function createSseProjectionCheck(): Promise<ConformanceCheckResult> {
  const frames = await collectStreamValues(
    toSseFrames(
      createFixtureEventStream(frameworkStreamTestFixtures.completedTurn)
    )
  );
  const firstFrame = frames[0];
  const toolResultFrame = frames.find((frame) =>
    frame.data.includes('"type":"tool.result"')
  );

  return createCheckResult(
    "framework.stream.sse_projection",
    [
      createAssertionResult(
        "sse_turn_start_event",
        firstFrame?.event === "turn.start" &&
          firstFrame.data.includes('"type":"turn.start"')
      ),
      createAssertionResult(
        "sse_tool_result_payload",
        toolResultFrame?.event === "tool.result" &&
          toolResultFrame.data.includes('"hits":2')
      ),
    ],
    {
      frameEvents: frames.map((frame) => frame.event ?? "message"),
    }
  );
}

async function createSseEagerSubscriptionCheck(): Promise<ConformanceCheckResult> {
  const [sseBranch, directBranch] = teeTuvrenStreamEvents(
    createFixtureEventStream(frameworkStreamTestFixtures.completedTurn),
    2
  );
  const sseFrames = toSseFrames(sseBranch);
  const directIterator = directBranch[Symbol.asyncIterator]();
  const firstDirectEvent = await directIterator.next();

  await waitForAsyncTurn();
  await directIterator.return?.();

  const frames = await collectStreamValues(sseFrames);

  return createCheckResult("framework.stream.sse_eager_subscription", [
    createAssertionResult(
      "sse_preserves_turn_start_after_delayed_poll",
      firstDirectEvent.done === false &&
        firstDirectEvent.value.type === "turn.start" &&
        frames[0]?.event === "turn.start"
    ),
  ]);
}

async function createAgUiProjectionCheck(): Promise<ConformanceCheckResult> {
  const warnings: string[] = [];
  const events = await collectStreamValues(
    toAgUiEvents(
      createFixtureEventStream(frameworkStreamTestFixtures.completedTurn),
      {
        onWarning(warning) {
          warnings.push(warning.code);
        },
      }
    )
  );
  const aguiTypes = events.map((event) => EventSchemas.parse(event).type);
  const stateSnapshot = events.find(
    (event) => event.type === EventType.STATE_SNAPSHOT
  );

  return createCheckResult(
    "framework.stream.agui_projection",
    [
      createAssertionResult(
        "agui_completed_turn_event_types",
        arraysAreEqual(aguiTypes, [
          EventType.RUN_STARTED,
          EventType.STEP_STARTED,
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.CUSTOM,
          EventType.TOOL_CALL_RESULT,
          EventType.STATE_SNAPSHOT,
          EventType.CUSTOM,
          EventType.CUSTOM,
          EventType.STEP_FINISHED,
          EventType.RUN_FINISHED,
        ])
      ),
      createAssertionResult(
        "agui_completed_turn_state_snapshot",
        stateSnapshot?.type === EventType.STATE_SNAPSHOT &&
          stateSnapshot.snapshot.contextManifest !== undefined
      ),
    ],
    {
      aguiTypes,
      warningCodes: warnings,
    }
  );
}

async function createAgUiFailedTurnCheck(): Promise<ConformanceCheckResult> {
  const events = await collectStreamValues(
    toAgUiEvents(
      createFixtureEventStream(frameworkStreamTestFixtures.failedTurn)
    )
  );
  const runError = events[1];

  return createCheckResult(
    "framework.stream.agui_failed_turn_error_projection",
    [
      createAssertionResult(
        "agui_failed_turn_run_error",
        runError?.type === EventType.RUN_ERROR &&
          runError.code === "runtime_execution_cancelled"
      ),
    ],
    {
      errorCode: runError?.type === EventType.RUN_ERROR ? runError.code : null,
    }
  );
}

async function createAgUiPausedTurnCheck(): Promise<ConformanceCheckResult> {
  const warnings: string[] = [];
  const events = await collectStreamValues(
    toAgUiEvents(
      createFixtureEventStream(frameworkStreamTestFixtures.pausedTurn),
      {
        onWarning(warning) {
          warnings.push(warning.code);
        },
      }
    )
  );
  const pausedEvent = events.find(
    (event) =>
      event.type === EventType.CUSTOM &&
      event.name === "tuvren.runtime.turn.paused"
  );

  return createCheckResult(
    "framework.stream.agui_paused_turn_fallback",
    [
      createAssertionResult(
        "agui_paused_turn_event_types",
        arraysAreEqual(
          events.map((event) => event.type),
          [
            EventType.RUN_STARTED,
            EventType.CUSTOM,
            EventType.CUSTOM,
            EventType.RUN_FINISHED,
          ]
        )
      ),
      createAssertionResult(
        "agui_paused_turn_custom_payload",
        pausedEvent?.type === EventType.CUSTOM &&
          JSON.stringify(pausedEvent.rawEvent) ===
            JSON.stringify(frameworkStreamTestFixtures.pausedTurn[2])
      ),
    ],
    {
      warningCodes: warnings,
    }
  );
}

function arraysAreEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
