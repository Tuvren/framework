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

import type { EpochMs, HashString } from "./kernel-records.js";
import type { ErasedPayload } from "./payload-codec.js";
import type {
  AgentConfig,
  TuvrenToolDefinition,
} from "./runtime-contract-shapes.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ContextManifest,
  InputSignal,
  TuvrenMessage,
} from "./runtime-data-contract-shapes.js";
import type { TuvrenStreamEvent } from "./runtime-event-contract-shapes.js";
import type { TuvrenError } from "./tuvren-error.js";

/* oxlint-disable typescript/method-signature-style -- Preserve the frozen public method signatures and their method bivariance under strictFunctionTypes. */

/**
 * The hard-stop execution bounds whose breach finalizes a turn as `failed`.
 * `maxConcurrentToolCalls` is intentionally excluded: it is a concurrency
 * throttle, not a terminal bound. (ADR-0043 §3.11)
 */
export type ExecutionBoundKind =
  | "maxIterations"
  | "maxToolCalls"
  | "maxWallClockMs";

/**
 * Framework-enforced per-turn execution bounds (ADR-0043 §3.11), applied above
 * the runner's own loop policy so a misbehaving or adversarial runner cannot
 * run a turn unbounded. Configured per runtime instance via
 * `createTuvren({ bounds })` / `RuntimeCoreOptions.bounds`. Unset fields take
 * the documented safe defaults; every configured bound must be a finite
 * positive integer. A runner cannot raise or disable a bound.
 */
export interface ExecutionBounds {
  /** Maximum concurrent tool calls (throttle, not a terminal bound). Default 16. */
  maxConcurrentToolCalls?: number;
  /** Maximum ReAct iterations per turn. Default 64. */
  maxIterations?: number;
  /** Maximum cumulative tool calls per turn. Default 256. */
  maxToolCalls?: number;
  /** End-to-end wall-clock deadline in milliseconds. Default 600_000. */
  maxWallClockMs?: number;
}

/**
 * Details carried by the `execution_bound_exceeded` `TuvrenRuntimeError`, the
 * fatal canonical `error` event, and the bounded-execution telemetry event when
 * a hard-stop bound is breached. (ADR-0043)
 */
export interface ExecutionBoundExceededDetails {
  /** Which hard-stop bound was breached. */
  bound: ExecutionBoundKind;
  /** The configured limit for the breached bound. */
  limit: number;
  /** The observed value at breach time. */
  observed: number;
}

/**
 * The point-in-time execution state returned by {@link ExecutionHandle.status}
 * (KrakenFrameworkSpecification §7.1). `approval` and `pauseReason` are
 * present only when `phase === "paused"`, and a paused status must carry
 * both — see {@link isExecutionStatus} for the enforced coupling invariant.
 */
export interface ExecutionStatus {
  activeAgent?: string;
  approval?: ApprovalRequest;
  iterationCount: number;
  manifest?: ContextManifest;
  pauseReason?: string;
  phase: "running" | "paused" | "completed" | "failed";
}

// `status` is the sole discriminant; `executionStatus.phase === status` for all terminal results.
/**
 * The terminal value {@link ExecutionHandle.awaitResult} resolves to
 * (KrakenFrameworkSpecification §7.1): a discriminated union on `status`
 * with `executionStatus.phase === status` as an invariant for both
 * branches. The promise resolves — never rejects — for both outcomes so
 * callers can exhaustively pattern-match without a try/catch; it rejects
 * only for cancellation.
 */
export type ExecutionResult =
  | {
      status: "completed";
      finalAssistantMessage?: TuvrenMessage;
      executionStatus: ExecutionStatus;
    }
  | {
      status: "failed";
      error: TuvrenError;
      subsequentErrors?: readonly TuvrenError[];
      executionStatus: ExecutionStatus;
    };

// Type intersection (not interface extension) because TS2312 forbids interfaces
// from extending discriminated unions.
/**
 * The terminal value {@link OrchestrationHandle.awaitResult} resolves to
 * (KrakenFrameworkSpecification §10.6): the parent's own
 * {@link ExecutionResult} plus `childResults`, keyed by descendant worker
 * identity and populated for spawned children whose `awaitResult()`
 * settled before or during parent completion. Child failures are recorded
 * without failing the parent unless the parent itself also failed.
 */
export type OrchestrationResult = ExecutionResult & {
  childResults: Record<string, ExecutionResult>;
};

/**
 * The host-facing control surface for driving and observing a Turn
 * (KrakenFrameworkSpecification §7.1). `events()` is the primary,
 * single-consumer output and iteration drives execution; `cancel()`
 * triggers the abort signal (or rejects pending approvals if paused);
 * `steer()` injects a signal consumed at the next iteration boundary
 * (valid only while running); `resolveApproval()` resumes a paused Turn and
 * returns a **new** handle; `status()` and `awaitResult()` read current and
 * terminal state respectively.
 */
export interface ExecutionHandle {
  awaitResult(): Promise<ExecutionResult>;
  cancel(): void;
  events(): AsyncIterable<TuvrenStreamEvent>;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  steer(signal: InputSignal): void;
}

/**
 * The control surface for a Turn spawned through the
 * {@link OrchestrationRuntime} (KrakenFrameworkSpecification §10.6). Adds
 * `allEvents()` (self plus descendant subtree events, single-consumer per
 * handle) and `spawn()` for launching child workers; overrides
 * `awaitResult()` and `resolveApproval()` to return orchestration-flavored
 * handles/results. `spawn()` is valid only while this handle is running.
 */
export interface OrchestrationHandle extends ExecutionHandle {
  allEvents(): AsyncIterable<TuvrenStreamEvent>;
  awaitResult(): Promise<OrchestrationResult>;
  resolveApproval(response: ApprovalResponse): OrchestrationHandle;
  spawn(input: { agent: string; signal: InputSignal }): OrchestrationHandle;
}

/**
 * The minimal, handle/tree-based multi-agent orchestration primitive
 * (KrakenFrameworkSpecification §10.6). Composes existing framework
 * primitives (`executeTurn`, `ExecutionHandle.events()`, Thread creation) —
 * no new kernel concepts. `executeTurn` starts both root and child Turns.
 */
export interface OrchestrationRuntime {
  executeTurn(input: {
    agent: string;
    branchId: string;
    runnerId?: string;
    parentTurnId?: string | null;
    schemaId?: string;
    signal: InputSignal;
    threadId: string;
    tools?: TuvrenToolDefinition[];
  }): OrchestrationHandle;
}

// ── Durable-Read Return Types (ADR-0036) ─────────────────────────────────────

/** A summary entry returned by {@link TuvrenRuntime.listThreads} (ADR-0036). */
export interface ThreadSummary {
  createdAtMs: EpochMs;
  rootTurnNodeHash: HashString;
  schemaId: string;
  threadId: string;
}

/** A summary entry returned by {@link TuvrenRuntime.listBranches} (ADR-0036). */
export interface BranchSummary {
  branchId: string;
  headTurnNodeHash: HashString;
  threadId: string;
}

/**
 * A point-in-time view of a Turn's durable state, returned by
 * {@link TuvrenRuntime.getTurnState} and iterated by
 * {@link TuvrenRuntime.getTurnHistory} (ADR-0036). `paths` projects the
 * schema's state paths (messages, manifest, etc.) at this TurnNode;
 * `previousTurnNodeHash` is `null` for the root Turn.
 */
export interface TurnSnapshot {
  eventHash: HashString | null;
  manifest: ContextManifest | null;
  paths: Record<string, HashString[] | HashString | null>;
  previousTurnNodeHash: HashString | null;
  schemaId: string;
  turnNodeHash: HashString;
  turnTreeHash: HashString;
}

/** Opaque to the host; see TechSpec §3.8. */
/** Opaque pagination cursor for {@link TuvrenRuntime.listThreads} (ADR-0036). */
export type ListThreadsCursor = string;
/** Opaque to the host; see TechSpec §3.8. */
/** Opaque pagination cursor for {@link TuvrenRuntime.getTurnHistory} (ADR-0036). */
export type TurnHistoryCursor = string;
/** Opaque to the host; see TechSpec §3.8. */
/** Opaque pagination cursor for {@link TuvrenRuntime.readBranchMessages} (ADR-0036). */
export type BranchMessagesCursor = string;

/**
 * Host-facing projection of the kernel reclamation summary (kernel spec §9.4;
 * cross-language authority: `@tuvren/kernel-protocol` `ReclamationSummary`).
 * Counts the durable state released and retained within the runtime's bound
 * Scope by a reachability reclamation sweep. The framework returns the kernel's
 * summary unchanged, so the two shapes are intentionally identical.
 */
export interface ReclamationSummary {
  releasedArchivedBranchCount: number;
  releasedObjectCount: number;
  releasedOrderedPathChunkCount: number;
  releasedRunCount: number;
  releasedTurnCount: number;
  releasedTurnNodeCount: number;
  releasedTurnTreeCount: number;
  retainedObjectCount: number;
}

/**
 * Host-facing data-lifecycle maintenance surface (ADR-0051; architecture flow
 * §4.17). The runtime owns the mechanism only; the host owns retention policy
 * and key custody. Erasure (right-to-erasure / crypto-shredding) is the host
 * destroying a Scope's payload-encryption keys on its own keyring — never a
 * runtime call, since the runtime never holds keys.
 */
export interface RuntimeMaintenance {
  /**
   * Drops the bound Scope's entire durable partition for full tenant
   * offboarding (architecture flow §4.17). Unlike `reclaim`, this removes all of
   * the Scope's state, not only the unreachable remainder. Per kernel spec §9.4
   * this is a substrate concern outside the kernel syscall surface, so it is
   * driven directly against the durable backend rather than through a kernel
   * operation. Crypto-shredding erasure remains the host destroying the Scope's
   * payload keys; this call removes the residual ciphertext partition. Rejects
   * when the runtime does not own a backend that supports partition drop (for
   * example when constructed with an externally-supplied kernel).
   */
  purgeScope(): Promise<void>;
  /**
   * Drives capability-gated reachability reclamation (kernel spec §9.4) for the
   * runtime's bound Scope: releases durable state unreachable from live roots
   * (non-archived branch heads, thread roots, active-run staged work),
   * grace-windowed against the oldest active execution lease so it can never
   * race recovery. Rejects with a persistence error when the backend does not
   * advertise `maintenance.reclamation`. The host decides when (and whether) to
   * call it; the runtime supplies no retention policy.
   */
  reclaim(options?: { nowMs?: EpochMs }): Promise<ReclamationSummary>;
}

/**
 * The framework's host-facing runtime surface: Thread/Branch lifecycle
 * (`createThread`, `createBranch`, `setBranchHead`), Turn execution
 * (`executeTurn`), the ADR-0036 durable-read surface (`listThreads`,
 * `listBranches`, `getThread`, `getTurnState`, `getTurnHistory`,
 * `readBranchMessages`), and the ADR-0051 data-lifecycle `maintenance`
 * surface. This is the top-level seam a host embeds to expose Kraken to
 * external consumers (APIs, UIs, protocol endpoints).
 */
export interface TuvrenRuntime {
  createBranch(input: {
    branchId?: string;
    threadId: string;
    fromTurnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    threadId: string;
    headTurnNodeHash: HashString;
  }>;
  createThread(input: {
    threadId?: string;
    schemaId?: string;
    initialBranchId?: string;
  }): Promise<{
    threadId: string;
    branchId: string;
    rootTurnNodeHash: HashString;
    rootTurnTreeHash: HashString;
  }>;
  executeTurn(input: {
    signal: InputSignal;
    threadId: string;
    branchId: string;
    schemaId?: string;
    runnerId?: string;
    config: AgentConfig;
    tools?: TuvrenToolDefinition[];
    parentTurnId?: string | null;
  }): ExecutionHandle;
  getThread(threadId: string): Promise<{
    threadId: string;
    schemaId: string;
    rootTurnNodeHash: HashString;
  } | null>;

  getTurnHistory(
    input: { threadId: string; branchId: string },
    options?: { limit?: number; before?: TurnHistoryCursor }
  ): AsyncIterableIterator<TurnSnapshot>;

  getTurnState(input: {
    threadId: string;
    branchId: string;
    turnNodeHash?: HashString;
  }): Promise<TurnSnapshot>;

  // listBranches is intentionally unbounded: branches per thread are bounded
  // by O(1) active divergence paths in v1 and kernel.branch.list is unpaginated.
  listBranches(input: { threadId: string }): Promise<BranchSummary[]>;

  // ── Durable-Read Surface (ADR-0036) ──────────────────────────────────────
  listThreads(options?: {
    limit?: number;
    cursor?: ListThreadsCursor;
    filter?: { schemaId?: string };
  }): Promise<{ threads: ThreadSummary[]; nextCursor?: ListThreadsCursor }>;

  // ── Data-Lifecycle Maintenance Surface (ADR-0051, §4.17) ─────────────────
  // Host-facing reclamation + tenant-offboarding mechanism. Retention policy
  // and key custody stay host-owned.
  maintenance: RuntimeMaintenance;

  // A reclaimed/crypto-shredded message (ADR-0051, KRT-BF005) surfaces as a typed
  // `ErasedPayload` marker (distinguished by `kind: "erased"`) instead of a
  // decoded message, so the read stays total and the lineage hash structure
  // referencing it is unchanged.
  readBranchMessages(input: {
    branchId: string;
    limit?: number;
    after?: BranchMessagesCursor;
  }): Promise<{
    messages: (ErasedPayload | TuvrenMessage)[];
    nextCursor?: BranchMessagesCursor;
  }>;
  setBranchHead(input: {
    branchId: string;
    turnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    archiveBranchId?: string;
  }>;
}

/* oxlint-enable typescript/method-signature-style */
