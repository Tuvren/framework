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

import { TuvrenRuntimeError } from "@tuvren/core";
import type { EpochMs, HashString } from "@tuvren/core";
import type { TuvrenStreamEvent } from "@tuvren/core/events";
import type {
  BranchMessagesCursor,
  BranchSummary,
  ContextManifest,
  ExecutionHandle,
  ListThreadsCursor,
  ReclamationSummary,
  RuntimeMaintenance,
  ThreadSummary,
  TurnHistoryCursor,
  TurnSnapshot,
  TuvrenRuntime,
} from "@tuvren/core/execution";
import type { ErasedPayload } from "@tuvren/core/lifecycle";
import type { TuvrenMessage } from "@tuvren/core/messages";

import {
  getTurnHistory,
  getTurnState,
  listBranches,
  listThreads,
  readBranchMessages,
} from "./durable-reads.js";
import type { PayloadCodecBinding } from "./payload-codec-seam.js";
import {
  createBoundExceededError,
  getBoundExceededDetails,
  isBoundExceededError,
} from "./runtime-core-bounds.js";
import { createRuntimeCoreExecutionController } from "./runtime-core-execution-controller.js";
import type { RuntimeCoreExecutionController } from "./runtime-core-execution-controller.js";
import {
  materializeRuntimeCoreContextMessages,
  resolveRuntimeCoreFailureActiveConfig,
  resolveRuntimeCoreHandoffSourceContext,
} from "./runtime-core-facade-adapters.js";
import {
  commitRuntimeCorePendingExtensionStateUpdates,
  completeRuntimeCoreExecution,
  completeRuntimeCoreIterationRun,
  createRuntimeCoreIterationTree,
  createRuntimeCoreRunnerHandoffContextPlan,
  createRuntimeCoreToolBatchEnvironment,
  publishRuntimeCorePauseOutcome,
  resumeRuntimeCorePausedToolExecution,
} from "./runtime-core-facade-execution.js";
import { createRuntimeCoreFacadeHosts } from "./runtime-core-facade-hosts.js";
import type { RuntimeCoreFacadeHosts } from "./runtime-core-facade-hosts.js";
import {
  ensureSchemaIdFacade,
  loadHeadStateFacade,
  readRecoveredActiveAgentNameFacade,
  readRecoveredRuntimeStatusFacade,
  resolveParentTurnIdFacade,
} from "./runtime-core-facade-ops.js";
import {
  cloneAgentConfigForRequest,
  createReadonlyRunnerToolRegistry,
  createRunnerAgentConfigSnapshot,
  resolveActiveMaxParallelToolCalls,
} from "./runtime-core-facade-utils.js";
import type { ActiveRunLease } from "./runtime-core-liveness.js";
import type { LoopState } from "./runtime-core-loop.js";
import {
  createRuntimeRunnerStreamEvent,
  emitRuntimeCheckpointEvents,
  emitRuntimeWarning,
  publishRuntimeCustomNamedEvent,
  publishRuntimeProjectedErrorEvent,
  publishRuntimeStreamEvent,
  stageRuntimeManifestRecord,
  stageRuntimeMessageRecord,
  stageRuntimeStatusRecordValue,
  stageRuntimeTurnLineageRecord,
  storeRuntimeEventKernelRecord,
  storeRuntimeKernelRecordValue,
} from "./runtime-core-observability.js";
import type {
  ResolvedRuntimeCoreOptions,
  RuntimeCoreOptions,
} from "./runtime-core-options.js";
import {
  DEFAULT_AGENT_SCHEMA,
  resolveRuntimeCoreOptions,
} from "./runtime-core-options.js";
import { hasRunLivenessKernel } from "./runtime-core-response.js";
import {
  advanceRuntimeCoreTurnAndBranchHead,
  checkpointRuntimeCoreResumeRunningStatus,
  completeRuntimeCoreTrackedRun,
  createRuntimeCoreTrackedRun,
  failRuntimeCoreTrackedRunWithoutBranchAdvance,
  resolveRuntimeCoreCheckpointedPausedRun,
  syncRuntimeCoreRunLeaseStateFromStepResult,
} from "./runtime-core-runtime-lifecycle.js";
import { projectError } from "./runtime-core-shared.js";
import { finalizeTurnStatus as finalizeRuntimeTurnStatus } from "./runtime-core-status.js";
import { createRuntimeTelemetryEmitter } from "./runtime-core-telemetry.js";
import type { RuntimeTelemetryEmitter } from "./runtime-core-telemetry.js";
import { finalizeRejectedPausedToolCancellation as finalizeRejectedRuntimePausedToolCancellation } from "./runtime-core-tool-resume.js";
import {
  applyRuntimeCoreTerminalAgentTransitionIfNeeded,
  createRuntimeCoreContextHelperBundle,
  resolveRuntimeCoreDefaultHandoffContextBuilder,
} from "./runtime-core-transition-support.js";
import type { RuntimeExecutionHandle } from "./runtime-execution-handle.js";
import type { ExecutionSessionRequest } from "./runtime-execution-types.js";

export type {
  RuntimeCoreOptions,
  RuntimeRunLivenessOptions,
  RuntimeWarning,
} from "./runtime-core-options.js";
export {
  DEFAULT_AGENT_SCHEMA,
  DEFAULT_AGENT_SCHEMA_ID,
  DEFAULT_MANIFEST_EXTENSION_STATE_WARNING_BUDGET_BYTES,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
} from "./runtime-core-options.js";

/**
 * Per-logical-turn execution-bounds accounting (ADR-0043, KRT-BD006), keyed by
 * execution handle and carried across approval pauses so a resume never
 * resets the wall-clock deadline or the cumulative tool-call count.
 */
interface BoundsTurnState {
  boundedTelemetryEmitted: boolean;
  deadlineMs: number;
  toolCallCount: number;
  wallClockTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The engine implementation of the host-facing `TuvrenRuntime` contract.
 *
 * A thin coordinator: it normalizes options once in the constructor, wires
 * the {@link RuntimeCoreFacadeHosts} seam that binds the split
 * `runtime-core-*` modules together, and forwards each surface (durable
 * reads, execution sessions, maintenance) to its owning module. Per-handle
 * mutable state (run leases, bounds accounting, warning dedup keys) lives in
 * `WeakMap`s so abandoned handles never leak.
 */
class RuntimeCore implements TuvrenRuntime {
  private readonly activeRunLeaseControllers = new WeakMap<
    RuntimeExecutionHandle,
    ActiveRunLease
  >();
  private readonly boundsTurnStates = new WeakMap<
    RuntimeExecutionHandle,
    BoundsTurnState
  >();
  private readonly executionController: RuntimeCoreExecutionController;
  private readonly hosts: RuntimeCoreFacadeHosts;
  private readonly manifestExtensionStateWarningKeys = new WeakMap<
    RuntimeExecutionHandle,
    Set<string>
  >();
  private readonly options: ResolvedRuntimeCoreOptions;
  private readonly telemetry: RuntimeTelemetryEmitter;

  constructor(options: RuntimeCoreOptions) {
    this.options = resolveRuntimeCoreOptions(options);
    this.telemetry = createRuntimeTelemetryEmitter({
      now: () => this.options.now(),
      scope: this.options.scope,
      telemetry: this.options.telemetry,
    });

    if (
      this.options.runLiveness !== undefined &&
      !hasRunLivenessKernel(this.options.kernel)
    ) {
      throw new TuvrenRuntimeError(
        "runLiveness requires a kernel that implements the kernel.run-liveness extension",
        {
          code: "missing_run_liveness_extension",
        }
      );
    }

    this.hosts = createRuntimeCoreFacadeHosts({
      activeRunLeaseControllers: this.activeRunLeaseControllers,
      advanceTurnAndBranchHead: async (handle, turnNodeHash) => {
        await advanceRuntimeCoreTurnAndBranchHead(
          this.options.kernel,
          handle,
          turnNodeHash
        );
      },
      applyTerminalAgentTransitionIfNeeded: async (...args) =>
        await applyRuntimeCoreTerminalAgentTransitionIfNeeded(
          {
            contextOps: this.hosts.contextOps,
            kernel: this.options.kernel,
            payloadCodecBinding: this.payloadBinding(),
          },
          ...args
        ),
      checkpointResumeRunningStatus: async (...args) =>
        await checkpointRuntimeCoreResumeRunningStatus(
          this.hosts.status,
          ...args
        ),
      cloneAgentConfigForRequest,
      commitPendingExtensionStateUpdates: async (...args) => {
        await commitRuntimeCorePendingExtensionStateUpdates(
          this.hosts,
          ...args
        );
      },
      completeExecution: async (...args) => {
        await completeRuntimeCoreExecution(this.hosts, ...args);
      },
      completeIterationRun: async (...args) =>
        await completeRuntimeCoreIterationRun(this.hosts, ...args),
      completeTrackedRun: async (...args) =>
        await completeRuntimeCoreTrackedRun(this.hosts.liveness, ...args),
      createContextEngineeringHelpers: (messageHashes, messages) =>
        createRuntimeCoreContextHelperBundle(
          this.options.kernel,
          this.payloadBinding(),
          messageHashes,
          messages
        ),
      createId: () => this.options.createId(),
      createIterationTree: async (...args) =>
        await createRuntimeCoreIterationTree(this.hosts, ...args),
      createReadonlyRunnerToolRegistry,
      createRunnerAgentConfigSnapshot,
      createRunnerHandoffContextPlan: (...args) =>
        createRuntimeCoreRunnerHandoffContextPlan(this.hosts, ...args),
      createRunnerPublishedEvent: (handle, event, loopState) =>
        createRuntimeRunnerStreamEvent(
          this.hosts.events,
          handle,
          event,
          loopState
        ),
      createToolBatchEnvironment: (...args) =>
        createRuntimeCoreToolBatchEnvironment(this.hosts, ...args),
      createTrackedRun: async (...args) => {
        await createRuntimeCoreTrackedRun(this.hosts.liveness, ...args);
      },
      defaultMaxParallelToolCalls: this.options.defaultMaxParallelToolCalls,
      defaultRunnerId: this.options.defaultRunnerId,
      emitStateObservability: (
        handle,
        loopState,
        turnNodeHash,
        iterationCount,
        manifest
      ) => {
        this.emitRuntimeStateObservability(
          handle,
          loopState,
          turnNodeHash,
          iterationCount,
          manifest
        );
      },
      enableStateObservability: () => this.options.enableStateObservability,
      failTrackedRunWithoutBranchAdvance: async (...args) => {
        await failRuntimeCoreTrackedRunWithoutBranchAdvance(
          this.hosts.turnProgress,
          ...args
        );
      },
      finalizeRejectedPausedToolCancellation: async (...args) =>
        await finalizeRejectedRuntimePausedToolCancellation(
          this.hosts.toolResume,
          ...args
        ),
      finalizeTurnStatus: async (...args) => {
        await finalizeRuntimeTurnStatus(this.hosts.status, ...args);
      },
      getManifestExtensionStateWarningBudgetBytes: () =>
        this.options.onWarning === undefined
          ? false
          : this.options.manifestExtensionStateWarningBudgetBytes,
      getOrCreateManifestExtensionStateWarningKeys: (handle) => {
        let warningKeys = this.manifestExtensionStateWarningKeys.get(handle);
        if (warningKeys === undefined) {
          warningKeys = new Set<string>();
          this.manifestExtensionStateWarningKeys.set(handle, warningKeys);
        }
        return warningKeys;
      },
      kernel: this.options.kernel,
      loadHeadState: async (branchId) =>
        await loadHeadStateFacade(
          this.options.kernel,
          this.payloadBinding(),
          branchId
        ),
      manifestExtensionStateWarning: (warning) => {
        emitRuntimeWarning(this.options.onWarning, warning);
      },
      materializeContextMessages: (hashes, helpers) =>
        materializeRuntimeCoreContextMessages(hashes, helpers),
      now: () => this.options.now(),
      payloadCodecBinding: this.payloadBinding(),
      publishCustomEvent: (handle, event, loopState) => {
        publishRuntimeCustomNamedEvent(
          this.hosts.events,
          handle,
          event,
          loopState
        );
      },
      publishEvent: (handle, event, loopState) => {
        this.publishRuntimeEvent(handle, event, loopState);
      },
      publishPauseOutcome: (...args) =>
        publishRuntimeCorePauseOutcome(this.hosts, ...args),
      publishProjectedError: (handle, error, fatal, loopState) => {
        this.publishRuntimeProjectedError(handle, error, fatal, loopState);
      },
      readRecoveredActiveAgentName: async (turnTreeHash) =>
        await readRecoveredActiveAgentNameFacade(
          this.options.kernel,
          turnTreeHash
        ),
      readRecoveredRuntimeStatus: async (turnTreeHash) =>
        await readRecoveredRuntimeStatusFacade(
          this.options.kernel,
          turnTreeHash
        ),
      resolveActiveMaxParallelToolCalls: (
        loopState,
        defaultMaxParallelToolCalls
      ) =>
        // Clamp the runner/agent/default parallelism to the framework bound so
        // parallel tool execution never exceeds maxConcurrentToolCalls. (BD006)
        Math.min(
          resolveActiveMaxParallelToolCalls(
            loopState.activeConfig,
            defaultMaxParallelToolCalls
          ),
          this.options.bounds.maxConcurrentToolCalls
        ),
      resolveAgentConfig: this.options.resolveAgentConfig,
      resolveCheckpointedPausedRun: async (...args) => {
        await resolveRuntimeCoreCheckpointedPausedRun(
          this.hosts.turnProgress,
          ...args
        );
      },
      resolveDefaultHandoffContextBuilder: (mode) =>
        resolveRuntimeCoreDefaultHandoffContextBuilder(
          this.options.handoffContextBuilder,
          mode
        ),
      resolveFailureActiveConfig: (handle) =>
        resolveRuntimeCoreFailureActiveConfig(
          handle.request.config,
          handle.status().activeAgent ?? handle.request.config.name,
          this.options.resolveAgentConfig
        ),
      resolveHandoffSourceContext: (
        plan,
        headState,
        loopState,
        targetConfig,
        helpers
      ) =>
        resolveRuntimeCoreHandoffSourceContext(
          {
            cloneAgentConfigForRequest,
            kernel: this.options.kernel,
          },
          plan,
          headState,
          loopState,
          targetConfig,
          helpers
        ),
      resolveParentTurnId: async (threadId, branchId, explicitParentTurnId) =>
        await resolveParentTurnIdFacade(
          this.options.kernel,
          this.options.resolveParentTurnId,
          threadId,
          branchId,
          explicitParentTurnId
        ),
      resolveTargetAgent: (targetAgent) =>
        this.options.resolveAgentConfig?.(targetAgent) ?? {
          name: targetAgent,
        },
      resumePausedToolExecution: async (...args) =>
        await resumeRuntimeCorePausedToolExecution(this.hosts, ...args),
      runLivenessOptions: this.options.runLiveness,
      stageManifest: async (runId, manifest, warningContext, taskId) =>
        await stageRuntimeManifestRecord(
          this.hosts.persistence,
          runId,
          manifest,
          warningContext,
          taskId
        ),
      stageMessage: async (runId, message, taskId) => {
        if (taskId === undefined) {
          throw new TypeError("message staging requires a task id");
        }

        return await stageRuntimeMessageRecord(
          this.hosts.persistence,
          runId,
          message,
          taskId
        );
      },
      stageRuntimeStatus: async (runId, status, taskId) =>
        await stageRuntimeStatusRecordValue(
          this.hosts.persistence,
          runId,
          status,
          taskId
        ),
      stageTurnLineage: async (runId, turnId, taskId, interruptedToolBatch) =>
        await stageRuntimeTurnLineageRecord(
          this.hosts.persistence,
          runId,
          turnId,
          taskId,
          interruptedToolBatch
        ),
      storeEventRecord: async (event) =>
        await storeRuntimeEventKernelRecord(this.hosts.persistence, event),
      storeKernelRecord: async (value, label) =>
        await storeRuntimeKernelRecordValue(
          this.hosts.persistence,
          value,
          label
        ),
      syncRunLeaseStateFromStepResult: (...args) => {
        syncRuntimeCoreRunLeaseStateFromStepResult(
          this.hosts.liveness,
          ...args
        );
      },
      treeCreate: async (schemaId, changes, baseTurnTreeHash) =>
        await this.options.kernel.tree.create(
          schemaId,
          changes,
          baseTurnTreeHash
        ),
    });
    this.executionController = createRuntimeCoreExecutionController({
      armWallClockBound: (handle) => {
        this.armWallClockBound(handle);
      },
      boundsDeadlineMs: (handle) => this.getBoundsTurnState(handle).deadlineMs,
      carryBoundsTurnState: (previousHandle, resumedHandle) => {
        this.carryBoundsTurnState(previousHandle, resumedHandle);
      },
      disarmWallClockBound: (handle) => {
        this.disarmWallClockBound(handle);
      },
      emitRuntimeStateObservability: (...args) => {
        this.emitRuntimeStateObservability(...args);
      },
      executionBounds: () => this.options.bounds,
      hosts: this.hosts,
      options: this.options,
      publishRuntimeEvent: (...args) => {
        this.publishRuntimeEvent(...args);
      },
      publishRuntimeProjectedError: (...args) => {
        this.publishRuntimeProjectedError(...args);
      },
      recordBoundsToolCalls: (handle, count) =>
        this.recordBoundsToolCalls(handle, count),
      telemetry: this.telemetry,
    });
  }

  /**
   * Creates a new branch on a thread, forked from an existing turn node.
   * Generates a branch id when the caller does not supply one.
   */
  async createBranch(input: {
    branchId?: string;
    fromTurnNodeHash: HashString;
    threadId: string;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    threadId: string;
  }> {
    return await this.options.kernel.branch.create(
      input.branchId ?? this.options.createId(),
      input.threadId,
      input.fromTurnNodeHash
    );
  }

  /**
   * Creates a new thread (and its initial branch), registering the default
   * agent schema first when no `schemaId` is supplied. Thread and branch ids
   * are generated when omitted.
   */
  async createThread(input: {
    initialBranchId?: string;
    schemaId?: string;
    threadId?: string;
  }): Promise<{
    branchId: string;
    rootTurnNodeHash: HashString;
    rootTurnTreeHash: HashString;
    threadId: string;
  }> {
    const schemaId = await this.ensureSchemaId(input.schemaId);
    return await this.options.kernel.thread.create(
      input.threadId ?? this.options.createId(),
      schemaId,
      input.initialBranchId ?? this.options.createId()
    );
  }

  /**
   * Starts a turn execution and returns its handle — the host-facing alias of
   * {@link createExecutionHandle}. Execution begins lazily: the loop is
   * kicked off on first consumption (iterating the handle's event stream or
   * awaiting its result), not by this call itself.
   */
  executeTurn(input: ExecutionSessionRequest): ExecutionHandle {
    return this.executionController.createExecutionHandle(input);
  }

  // ── Durable-Read Surface (KRT-AO003..AO005) ────────────────────────────

  /** Lists thread summaries, optionally filtered by schema id, with cursor
   * pagination. Forwarded to the durable-read module over the kernel. */
  async listThreads(options?: {
    limit?: number;
    cursor?: ListThreadsCursor;
    filter?: { schemaId?: string };
  }): Promise<{ threads: ThreadSummary[]; nextCursor?: ListThreadsCursor }> {
    return await listThreads(this.options.kernel, options);
  }

  /** Lists the branches of a thread. */
  async listBranches(input: { threadId: string }): Promise<BranchSummary[]> {
    return await listBranches(this.options.kernel, input);
  }

  // ── Data-Lifecycle Maintenance Surface (ADR-0051, §4.17) ────────────────

  /**
   * The data-lifecycle maintenance surface (ADR-0051, §4.17): `reclaim`
   * forwards to the kernel's reclamation mechanism, and `purgeScope` drops
   * the bound Scope's substrate partition when the runtime owns a backend
   * that supports it (rejecting with `scope_purge_unsupported` otherwise).
   */
  get maintenance(): RuntimeMaintenance {
    return {
      purgeScope: async (): Promise<void> => {
        await this.purgeBoundScope();
      },
      reclaim: async (options?: {
        nowMs?: EpochMs;
      }): Promise<ReclamationSummary> =>
        // The kernel reclamation summary is structurally the host-facing
        // ReclamationSummary; capability gating + grace-windowing live in the
        // kernel/backend, so the runtime only forwards the mechanism call.
        await this.options.kernel.maintenance.reclaim(options),
    };
  }

  private async purgeBoundScope(): Promise<void> {
    if (this.options.purgeScope === undefined) {
      throw new TuvrenRuntimeError(
        "maintenance.purgeScope is unavailable: the runtime does not own a backend that supports dropping a Scope partition (for example when constructed with an externally-supplied kernel)",
        { code: "scope_purge_unsupported" }
      );
    }
    await this.options.purgeScope();
  }

  /** Reads a turn snapshot at the branch head, or at an explicit turn node
   * when `turnNodeHash` is supplied. */
  async getTurnState(input: {
    threadId: string;
    branchId: string;
    turnNodeHash?: HashString;
  }): Promise<TurnSnapshot> {
    return await getTurnState(this.options.kernel, input);
  }

  /** Iterates turn snapshots backwards from the branch head (or from the
   * `before` cursor), newest first. */
  getTurnHistory(
    input: { threadId: string; branchId: string },
    options?: { limit?: number; before?: TurnHistoryCursor }
  ): AsyncIterableIterator<TurnSnapshot> {
    return getTurnHistory(this.options.kernel, input, options);
  }

  /**
   * Reads a branch's messages oldest-first with cursor pagination, decrypting
   * durable payloads through the bound codec; a crypto-shredded message
   * surfaces as an `ErasedPayload` marker instead of its content.
   */
  async readBranchMessages(input: {
    branchId: string;
    limit?: number;
    after?: BranchMessagesCursor;
  }): Promise<{
    messages: (ErasedPayload | TuvrenMessage)[];
    nextCursor?: BranchMessagesCursor;
  }> {
    return await readBranchMessages(
      this.options.kernel,
      this.payloadBinding(),
      input
    );
  }

  /** Fetches a thread's root metadata, or `null` when it does not exist. */
  async getThread(threadId: string): Promise<{
    rootTurnNodeHash: HashString;
    schemaId: string;
    threadId: string;
  } | null> {
    return await this.options.kernel.thread.get(threadId);
  }

  /**
   * Moves a branch head to an explicit turn node (for example to rewind or
   * fast-forward a branch). When the kernel preserves the displaced lineage on
   * an archive branch, its id is surfaced as `archiveBranchId`.
   */
  async setBranchHead(input: {
    branchId: string;
    turnNodeHash: HashString;
  }): Promise<{
    archiveBranchId?: string;
    branchId: string;
    headTurnNodeHash: HashString;
  }> {
    const result = await this.options.kernel.branch.setHead(
      input.branchId,
      input.turnNodeHash
    );

    return {
      archiveBranchId: result.archiveBranch?.branchId,
      branchId: result.branch.branchId,
      headTurnNodeHash: result.branch.headTurnNodeHash,
    };
  }

  /** Carries per-turn bounds accounting from a paused handle to its resume. */
  private carryBoundsTurnState(
    previousHandle: RuntimeExecutionHandle,
    resumedHandle: RuntimeExecutionHandle
  ): void {
    const previousBounds = this.boundsTurnStates.get(previousHandle);
    if (previousBounds !== undefined) {
      this.boundsTurnStates.set(resumedHandle, {
        boundedTelemetryEmitted: previousBounds.boundedTelemetryEmitted,
        deadlineMs: previousBounds.deadlineMs,
        toolCallCount: previousBounds.toolCallCount,
      });
    }
  }

  // ── Execution Bounds (ADR-0043, KRT-BD006) ───────────────────────────────

  /**
   * Returns the per-turn bounds state for a handle, initializing the
   * wall-clock deadline (`now + maxWallClockMs`) and a zero tool-call count
   * on first access.
   */
  private getBoundsTurnState(handle: RuntimeExecutionHandle): BoundsTurnState {
    let state = this.boundsTurnStates.get(handle);
    if (state === undefined) {
      state = {
        boundedTelemetryEmitted: false,
        deadlineMs: this.options.now() + this.options.bounds.maxWallClockMs,
        toolCallCount: 0,
      };
      this.boundsTurnStates.set(handle, state);
    }
    return state;
  }

  /**
   * Arm the end-to-end wall-clock deadline as a real timer so the framework
   * stops awaiting in-flight model/tool work at `maxWallClockMs` by aborting
   * the handle with the bounds terminal error. The abort propagates through
   * `TuvrenPrompt.signal` and `ToolExecutionContext.signal`. The timer is
   * unref'd so it never keeps the process alive.
   */
  private armWallClockBound(handle: RuntimeExecutionHandle): void {
    const state = this.getBoundsTurnState(handle);
    if (state.wallClockTimer !== undefined) {
      return;
    }
    const limit = this.options.bounds.maxWallClockMs;
    const remaining = Math.max(0, state.deadlineMs - this.options.now());
    const timer = setTimeout(() => {
      handle.abortWithError(
        createBoundExceededError("maxWallClockMs", limit, limit)
      );
    }, remaining);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    state.wallClockTimer = timer;
  }

  /** Cancels the armed wall-clock timer, if any, when a loop run exits. */
  private disarmWallClockBound(handle: RuntimeExecutionHandle): void {
    const state = this.boundsTurnStates.get(handle);
    if (state?.wallClockTimer !== undefined) {
      clearTimeout(state.wallClockTimer);
      state.wallClockTimer = undefined;
    }
  }

  /**
   * Adds a batch's tool-call count to the turn's cumulative total and returns
   * the new total for `maxToolCalls` enforcement by the loop facade.
   */
  private recordBoundsToolCalls(
    handle: RuntimeExecutionHandle,
    count: number
  ): number {
    const state = this.getBoundsTurnState(handle);
    state.toolCallCount += count;
    return state.toolCallCount;
  }

  /**
   * Emit the bounded-execution telemetry event exactly once per handle when a
   * fatal terminal error is the bounds error. Wired into the projected-error
   * path so it fires for both the loop-boundary and in-flight-abort routes.
   */
  private emitBoundedTelemetryIfNeeded(
    handle: RuntimeExecutionHandle,
    error: Error,
    loopState: LoopState
  ): void {
    const details = getBoundExceededDetails(error);
    if (details === undefined) {
      return;
    }
    const state = this.getBoundsTurnState(handle);
    if (state.boundedTelemetryEmitted) {
      return;
    }
    state.boundedTelemetryEmitted = true;
    this.telemetry.bounded({ details, handle, loopState });
  }

  /** Publishes a stream event to the handle and mirrors it into telemetry. */
  private publishRuntimeEvent(
    handle: RuntimeExecutionHandle,
    event: TuvrenStreamEvent,
    loopState: LoopState
  ): void {
    publishRuntimeStreamEvent(this.hosts.events, handle, event, loopState);
    this.telemetry.eventFromStream(handle, event, loopState);
  }

  /**
   * Publishes a projected `error` stream event (and its telemetry mirror);
   * a fatal bound-exceeded error additionally triggers the once-per-handle
   * `execution.bounded` telemetry emission.
   */
  private publishRuntimeProjectedError(
    handle: RuntimeExecutionHandle,
    error: Error,
    fatal: boolean,
    loopState: LoopState
  ): void {
    publishRuntimeProjectedErrorEvent(
      this.hosts.events,
      handle,
      error,
      fatal,
      loopState
    );
    this.telemetry.eventFromStream(
      handle,
      {
        error: projectError(error),
        fatal,
        timestamp: this.options.now(),
        type: "error",
      },
      loopState
    );
    // A fatal bounds error anchors the terminal bounded-execution path: emit the
    // execution.bounded telemetry event alongside the fatal error event (before
    // the failed turn.end), exactly once per handle. (ADR-0043, BD006)
    if (fatal && isBoundExceededError(error)) {
      this.emitBoundedTelemetryIfNeeded(handle, error, loopState);
    }
  }

  /** Emits `state.checkpoint` observability events plus their telemetry
   * mirror after turn state advances. */
  private emitRuntimeStateObservability(
    handle: RuntimeExecutionHandle,
    loopState: LoopState,
    turnNodeHash: HashString,
    iterationCount: number,
    manifest?: ContextManifest
  ): void {
    emitRuntimeCheckpointEvents(
      this.hosts.events,
      handle,
      loopState,
      turnNodeHash,
      iterationCount,
      manifest
    );
    this.telemetry.eventFromStream(
      handle,
      {
        iterationCount,
        timestamp: this.options.now(),
        turnNodeHash,
        type: "state.checkpoint",
      },
      loopState
    );
  }

  private async ensureSchemaId(schemaId?: string): Promise<string> {
    return await ensureSchemaIdFacade(
      this.options.kernel,
      DEFAULT_AGENT_SCHEMA,
      schemaId
    );
  }

  // The crypto-shredding binding (codec + Scope) threaded to every message
  // write/read seam (KRT-BF005).
  private payloadBinding(): PayloadCodecBinding {
    return { codec: this.options.payloadCodec, scope: this.options.scope };
  }
}

/**
 * Creates the engine implementation of the host-facing `TuvrenRuntime`
 * contract over a kernel.
 *
 * This is the low-level factory consumed by `createTuvren` (which supplies
 * `defaultRunnerId`, `runnerRegistry`, and `kernel` itself) and by hosts on
 * the advanced composition surface.
 *
 * @param options - See {@link RuntimeCoreOptions}; `kernel` and
 *   `defaultRunnerId` are required.
 * @returns A `TuvrenRuntime` bound to the supplied kernel, registry, codec,
 *   bounds, and telemetry routing.
 * @throws {TuvrenRuntimeError} With code `missing_run_liveness_extension` when
 *   `runLiveness` is configured against a kernel lacking the
 *   `kernel.run-liveness` extension, or a validation error when a numeric
 *   option (bounds, parallelism, budgets) is out of range.
 */
export const createTuvrenRuntime = (
  options: RuntimeCoreOptions
): TuvrenRuntime => new RuntimeCore(options);
