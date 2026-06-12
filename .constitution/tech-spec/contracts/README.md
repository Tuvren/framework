# Interface Contracts

> **Authority note:** This file is descriptive documentation migrated verbatim from `TechSpec.md §4`. The authoritative raw interface contracts are boundary-owned (TypeSpec `main.tsp`, generated JSON Schema, `.proto`, and language bindings under `boundaries/<area>/contracts/<surface>/spec/`). Per ADR-023/024/025 and the authority-packet `forbiddenAuthoritySources`, the constitution is never the cross-implementation contract oracle — it points to boundary authority rather than duplicating raw contract files.

## 4. Interface Contract

### 4.0 Shared Error Foundation

- **Style:** shared cross-boundary TypeScript contract
- **Ownership:** `@tuvren/core/errors` (per ADR-037) owns the shared error base class and category subclasses. Concrete packages own their package-specific `code` values and message text. The deprecated `@tuvren/core-types` package re-exports from `@tuvren/core/errors` for one cycle.
- **Compatibility Strategy:** `TuvrenError` shape, subclass names, and stable `code` values are semver-governed public API. Adding a new error subclass is semver-minor. Changing or removing an existing stable `code` is semver-major.
- **Code policy:** every `TuvrenError` carries a stable lowercase snake_case `code`. Category is conveyed by the subclass, not by a required string prefix.
- **Projection rule:** when errors cross logging, streaming, or host boundaries, implementations must preserve at least `name`, `message`, `code`, and optional `details`.

```ts
export type TuvrenErrorCode = string;

export interface TuvrenErrorOptions {
  code: TuvrenErrorCode;
  cause?: unknown;
  details?: unknown;
}

export abstract class TuvrenError extends Error {
  readonly code: TuvrenErrorCode;
  readonly details?: unknown;
  override readonly cause?: unknown;

  protected constructor(message: string, options: TuvrenErrorOptions);
}

export class TuvrenValidationError extends TuvrenError {}
export class TuvrenPersistenceError extends TuvrenError {}
export class TuvrenLineageError extends TuvrenError {}
export class TuvrenRecoveryError extends TuvrenError {}
export class TuvrenRuntimeError extends TuvrenError {}
export class TuvrenProviderError extends TuvrenError {}
```

Concrete code examples already defined in the authoritative specs such as `structured_output_validation` and `invalid_loop_policy` are `TuvrenRuntimeError` codes. Backend-specific failures must normalize to `TuvrenPersistenceError` codes before surfacing through shared contracts.

### 4.1 Host-Facing TypeScript Framework API

- **Style:** library API
- **Authentication / Authorization:** Not built into Tuvren Runtime. Host applications authenticate and authorize their own callers before exposing runtime operations.
- **Compatibility Strategy:** Exported TypeScript framework APIs follow semantic versioning. Additive methods and additive optional fields are minor-compatible.
- **Validator note:** Runtime `is*` / `assert*` guards treat the current released payload shapes as exact for that version. Minor releases that add optional fields must extend those validators in the same release; older releases are not required to accept newer payloads.
- **Error model:** Typed `TuvrenError` subclasses with stable `code` values plus canonical `error` stream events.
- **Driver note:** The host-facing framework API is driver-neutral. Callers may select a concrete driver, but the host surface does not become ReAct-specific.
- **Package partition note:** Per ADR-037, the merged `boundaries/shared/contracts/core/spec/authority-packet.json` is the single machine authority anchor for the shared framework runtime semantics, host-facing runtime surface, event vocabulary, tool contracts, driver contracts, and provider contracts. `@tuvren/core` exposes these through subpath exports (`/messages`, `/tools`, `/events`, `/errors`, `/execution`, `/driver`, `/provider`, `/extensions`, `/telemetry`); the historical `@tuvren/runtime-api`, `@tuvren/event-stream`, `@tuvren/tool-contracts`, `@tuvren/driver-api`, and `@tuvren/core-types` packages remain as deprecated re-export shims for one cycle and then are removed. `@tuvren/runtime` is the slim convenience package exposing `createTuvren({...})` plus curated re-exports.
- **Durable-read note:** Per ADR-036, the `TuvrenRuntime` interface now exposes `listThreads`, `listBranches`, `getTurnState`, `getTurnHistory`, and `readBranchMessages` as host-facing durable-read operations that compose existing kernel structural primitives plus the new `thread.list` syscall (ADR-034). Pagination follows the Architecture §6 rule: history surfaces use cursor + async iterator (`getTurnHistory`); collection surfaces use cursor + optional limit (`listThreads`, `readBranchMessages`). Exception: `listBranches` is intentionally unbounded because branches per thread are bounded by O(1) active divergence paths in v1 and the underlying `kernel.branch.list` primitive is itself unpaginated. Cursors are opaque to the host; their runtime structure is specified in §3.8.
- **Handle terminal-value note:** Per ADR-035, `ExecutionHandle` now exposes `awaitResult(): Promise<ExecutionResult>` on the base interface. `OrchestrationHandle.awaitResult()` overrides to return `OrchestrationResult` (a type intersection `ExecutionResult & { childResults: Record<string, ExecutionResult> }`) with subtree-aggregated final values.

```ts
export type HashString = string;
export type EpochMs = number; // must always be a safe integer

export interface ThreadSummary {
  threadId: string;
  schemaId: string;
  rootTurnNodeHash: HashString;
  createdAtMs: EpochMs;
}

export interface BranchSummary {
  branchId: string;
  threadId: string;
  headTurnNodeHash: HashString;
}

export interface TurnSnapshot {
  turnNodeHash: HashString;
  previousTurnNodeHash: HashString | null;
  turnTreeHash: HashString;
  schemaId: string;
  eventHash: HashString | null;
  manifest: ContextManifest | null;
  paths: Record<string, HashString[] | HashString | null>;
}

export type ListThreadsCursor = string;       // opaque to host; see §3.8
export type TurnHistoryCursor = string;       // opaque to host; see §3.8
export type BranchMessagesCursor = string;    // opaque to host; see §3.8

export interface TuvrenRuntime {
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

  getThread(threadId: string): Promise<{
    threadId: string;
    schemaId: string;
    rootTurnNodeHash: HashString;
  } | null>;

  createBranch(input: {
    branchId?: string;
    threadId: string;
    fromTurnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    threadId: string;
    headTurnNodeHash: HashString;
  }>;

  setBranchHead(input: {
    branchId: string;
    turnNodeHash: HashString;
  }): Promise<{
    branchId: string;
    headTurnNodeHash: HashString;
    archiveBranchId?: string;
  }>;

  executeTurn(input: {
    signal: InputSignal;
    threadId: string;
    branchId: string;
    schemaId?: string;
    driverId?: string;
    config: AgentConfig;
    tools?: TuvrenToolDefinition[];
    parentTurnId?: string | null;
  }): ExecutionHandle;

  // ── Durable-Read Surface (ADR-036) ────────────────────────────────
  listThreads(options?: {
    limit?: number;
    cursor?: ListThreadsCursor;
    filter?: { schemaId?: string };
  }): Promise<{ threads: ThreadSummary[]; nextCursor?: ListThreadsCursor }>;

  // listBranches is intentionally unbounded: branches per thread are bounded by O(1) active
  // divergence paths in v1; paginating would require a kernel-side cursor that does not exist.
  listBranches(input: { threadId: string }): Promise<BranchSummary[]>;

  getTurnState(input: {
    threadId: string;
    branchId: string;
    turnNodeHash?: HashString;          // defaults to current branch head
  }): Promise<TurnSnapshot>;

  getTurnHistory(
    input: { threadId: string; branchId: string },
    options?: { limit?: number; before?: TurnHistoryCursor },
  ): AsyncIterableIterator<TurnSnapshot>;

  readBranchMessages(input: {
    branchId: string;
    limit?: number;
    after?: BranchMessagesCursor;  // oldest-first order; cursor advances forward through history
  }): Promise<{ messages: TuvrenMessage[]; nextCursor?: BranchMessagesCursor }>;
}

// `status` is the sole discriminant. `executionStatus.phase` always equals `status`
// for terminal results (invariant: status === executionStatus.phase).
export type ExecutionResult =
  | {
      status: "completed";
      finalAssistantMessage?: TuvrenMessage;
      executionStatus: ExecutionStatus;
    }
  | {
      status: "failed";
      error: TuvrenError;
      executionStatus: ExecutionStatus;
    };

// Must be a type intersection because ExecutionResult is a discriminated union;
// `interface extends` on a union type is TS2312-invalid.
export type OrchestrationResult = ExecutionResult & {
  // Subtree-aggregated final values for spawned children, keyed by
  // descendant execution-source identity. Populated only when spawn()
  // produced child handles whose awaitResult() resolved before parent
  // completion. Empty when no children were spawned.
  childResults: Record<string, ExecutionResult>;
};

export interface ExecutionHandle {
  events(): AsyncIterable<TuvrenStreamEvent>;
  cancel(): void;
  steer(signal: InputSignal): void;
  resolveApproval(response: ApprovalResponse): ExecutionHandle;
  status(): ExecutionStatus;
  // ── Terminal-value surface (ADR-035) ─────────────────────────────
  awaitResult(): Promise<ExecutionResult>;
}

export interface OrchestrationHandle extends ExecutionHandle {
  resolveApproval(response: ApprovalResponse): OrchestrationHandle;
  spawn(input: { agent: string; signal: InputSignal }): OrchestrationHandle;
  allEvents(): AsyncIterable<TuvrenStreamEvent>;
  awaitResult(): Promise<OrchestrationResult>;
}

export interface OrchestrationRuntime {
  executeTurn(input: {
    agent: string;
    signal: InputSignal;
    threadId: string;
    branchId: string;
    schemaId?: string;
    driverId?: string;
    tools?: TuvrenToolDefinition[];
    parentTurnId?: string | null;
  }): OrchestrationHandle;
}

- `spawn()` is valid only while the current orchestration handle is running.
- `spawn()` starts the child execution immediately; `awaitResult()` does not satisfy the parent launch precondition by itself.
- Child launches inherit the caller's explicit execution surface (`driverId`, per-request `tools`) because `spawn()` intentionally stays minimal.
- `InputSignal.parts` and persisted message `parts` are non-empty arrays in the shared contract; empty payload arrays are rejected at validation time.
- Once `resolveApproval(...)` returns a replacement handle, further control calls on the old paused handle are invalid.

export interface ExecutionStatus {
  phase: "running" | "paused" | "completed" | "failed";
  iterationCount: number;
  activeAgent?: string;
  manifest?: ContextManifest;
  pauseReason?: string;
  approval?: ApprovalRequest;
}

export interface AgentConfig {
  name: string;
  model?: string | TuvrenProvider;
  systemPrompt?: string;
  tools?: TuvrenToolDefinition[];
  extensions?: TuvrenExtension[];
  loopPolicy?: LoopPolicy;
  contextPolicy?: ContextPolicy;
  responseFormat?: StructuredOutputRequest;
  maxIterations?: number;
  maxParallelToolCalls?: number;
}
```

`ApprovalDecision.message` is optional operator commentary for every approval decision type. When present, runtime implementations must attach it to the resulting `ToolResultPart` produced by approval resolution rather than staging it as a separate `user` message or treating it as steering input. Reject and custom decisions therefore remain structurally valid without a message, but the runtime must synthesize a default error explanation when one is omitted.

`AgentConfig.maxParallelToolCalls` is an optional positive safe integer override for the shared runtime's parallel tool execution cap. When omitted, runtime-core uses its host-configured `defaultMaxParallelToolCalls`, which defaults to `10`.

Runtime-core options include `defaultMaxParallelToolCalls?: number`, `manifestExtensionStateWarningBudgetBytes?: number | false`, and `onWarning?: (warning: RuntimeWarning) => void`. Manifest state budget warnings are advisory host callbacks, not execution events and not hard limits. The default warning budget is `256 KiB` per extension namespace; `false` disables budget checks.

### 4.2 Kernel Protocol Surface

- **Style:** protocol-shaped library contract for the first TypeScript implementation
- **Authentication / Authorization:** Internal kernel boundary used by framework packages and backend adapters
- **Compatibility Strategy:** Protocol-first contract. Breaking changes to record shapes, operation signatures, or validation semantics are semver-major.
- **Error model:** `TuvrenError` with persistence, validation, lineage, and recovery codes
- **Concrete payload rule:** The frozen kernel specification names `ObserveResult.annotations` as `Object[]` and `signals` as `Signal[]`, but does not define their first TypeScript wire shape. The authoritative TypeScript realization is:
  - observe annotations are `KernelObject[]` carried into `run.completeStep`; the TypeScript kernel persists them as `StoredObserveAnnotation` records outside TurnNode identity and exposes their presence through conformance evidence rather than a new base syscall
  - observe signals are `KernelRecord[]`; the TypeScript kernel stores them in `pendingSignalsCbor` for the same Run so the next `run.beginStep` returns them in `StepContext.signals`
  - the base surface is **30 operations across 10 groups** (per ADR-034). The 28-vs-29 historical drift in docs and prior TechSpec revisions is resolved: `branch.list` had been added without updating the narrative count, and `thread.list` is added concurrently in this revision. Both are structural enumeration primitives. The new `thread.list` is **capability-advertised**: backends declare the `thread.enumeration` capability bit (§3.7), and the kernel rejects `thread.list` invocations against backends without the bit with `TuvrenPersistenceError` code `kernel_capability_unsupported`.
  - stale-running leases use the optional `RuntimeKernelRunLiveness` extension below and must be advertised by capability

```ts
export type KernelSignal = KernelRecord;
export type VerdictDisposition = "HardFail" | "SoftFail" | "EndTurn";

export interface ObserveResult {
  annotations: KernelObject[];
  signals: KernelSignal[];
}

export type Verdict =
  | { kind: "proceed" }
  | { kind: "abort"; disposition: VerdictDisposition; reason: string }
  | { kind: "modify"; transform: KernelRecord }
  | { kind: "pause"; reason: string; resumptionSchema: KernelRecord }
  | { kind: "retry"; adjustment: KernelRecord };

export type ComposedVerdict = Verdict;

export interface StepContext {
  currentTurnNodeHash: HashString;
  schema: TurnTreeSchema;
  step: StepDeclaration;
  signals: KernelSignal[];
}

export interface RuntimeKernel {
  store: {
    put(blob: Uint8Array, mediaType?: string): Promise<HashString>;
    get(hash: HashString): Promise<Uint8Array | null>;
    has(hash: HashString): Promise<boolean>;
  };

  schema: {
    register(schema: TurnTreeSchema): Promise<string>;
    get(schemaId: string): Promise<TurnTreeSchema | null>;
  };

  tree: {
    create(
      schemaId: string,
      changes: Record<string, HashString[] | HashString | null>,
      baseTurnTreeHash?: HashString,
    ): Promise<HashString>;
    incorporate(
      baseTurnTreeHash: HashString,
      stagedResults: StagedResult[],
    ): Promise<HashString>;
    diff(treeHashA: HashString, treeHashB: HashString): Promise<string[]>;
    resolve(
      treeHash: HashString,
      path: string,
    ): Promise<HashString[] | HashString | null>;
    manifest(
      treeHash: HashString,
    ): Promise<Record<string, HashString[] | HashString | null>>;
  };

  node: {
    get(hash: HashString): Promise<TurnNode | null>;
    walkBack(fromHash: HashString): AsyncIterable<TurnNode>;
  };

  thread: {
    create(
      threadId: string,
      schemaId: string,
      initialBranchId: string,
    ): Promise<ThreadCreateResult>;
    get(threadId: string): Promise<ThreadRecord | null>;
    // ADR-034: capability-advertised; rejects with
    // TuvrenPersistenceError code "kernel_capability_unsupported"
    // when the backend does not advertise thread.enumeration.
    list(options?: {
      limit?: number;
      cursor?: KernelThreadListCursor;
      filter?: { schemaId?: string };
    }): Promise<{
      threads: ThreadRecord[];
      nextCursor?: KernelThreadListCursor;
    }>;
  };

  branch: {
    create(
      branchId: string,
      threadId: string,
      fromTurnNodeHash: HashString,
    ): Promise<BranchRecord>;
    get(branchId: string): Promise<BranchRecord | null>;
    setHead(branchId: string, turnNodeHash: HashString): Promise<SetHeadResult>;
    list(threadId: string): Promise<Array<[string, HashString]>>;
  };

  staging: {
    stage(
      runId: string,
      blob: Uint8Array,
      taskId: string,
      objectType: string,
      status: "completed" | "failed" | "interrupted",
      interruptPayload?: KernelRecord,
    ): Promise<{ objectHash: HashString; stagedResult: StagedResult }>;
    current(runId: string): Promise<StagedResult[]>;
  };

  run: {
    create(
      runId: string,
      turnId: string,
      branchId: string,
      schemaId: string,
      startTurnNodeHash: HashString,
      steps: StepDeclaration[],
    ): Promise<RunRecord>;
    beginStep(runId: string, stepId: string): Promise<StepContext>;
    completeStep(
      runId: string,
      stepId: string,
      eventHash?: HashString,
      observeResults?: ObserveResult[],
      treeHash?: HashString,
    ): Promise<{ checkpointed: boolean; turnNodeHash?: HashString }>;
    complete(
      runId: string,
      status: "completed" | "failed" | "paused",
      eventHash?: HashString,
    ): Promise<{ turnNodeHash?: HashString }>;
    recover(runId: string): Promise<RecoveryState>;
  };

  verdicts: {
    compose(verdicts: Verdict[]): Promise<ComposedVerdict>;
  };

  turn: {
    create(
      turnId: string,
      threadId: string,
      branchId: string,
      parentTurnId: string | null | undefined,
      startTurnNodeHash: HashString,
    ): Promise<TurnRecord>;
    get(turnId: string): Promise<TurnRecord | null>;
    updateHead(turnId: string, headTurnNodeHash: HashString): Promise<void>;
  };
}

export interface RuntimeKernelRunLiveness {
  runLiveness: {
    createLeasedRun(
      input: {
        runId: string;
        turnId: string;
        branchId: string;
        schemaId: string;
        startTurnNodeHash: HashString;
        steps: StepDeclaration[];
        executionOwnerId: string;
        leaseExpiresAtMs: EpochMs;
      },
    ): Promise<RunRecord>;
    renewLease(
      runId: string,
      executionOwnerId: string,
      fencingToken: string,
      nextLeaseExpiresAtMs: EpochMs,
    ): Promise<{ fencingToken: string; leaseExpiresAtMs: EpochMs }>;
    listExpired(nowMs: EpochMs): Promise<RunRecord[]>;
    preemptExpired(
      runId: string,
      preemptingOwnerId: string,
      nowMs: EpochMs,
      reason: string,
    ): Promise<RecoveryState>;
  };
}
```

Turn parent validation is branch-aware through the active head lineage rather than branch-id equality alone: the first Turn on a forked Branch may use the source Branch head Turn as `parentTurnId` when both Turns share a Thread and the parent head matches `startTurnNodeHash`; subsequent Turns on that fork use the immediately previous Turn on the fork.

The target TypeScript implementation package for this surface is `@tuvren/kernel-runtime` under `boundaries/kernel/implementations/typescript/runtime-kernel`. It composes a `RuntimeBackend` into the documented `RuntimeKernel` surface; backend packages remain storage adapters and must not become alternate syscall implementations.

### 4.3 Backend Adapter Contract

- **Style:** library API
- **Authentication / Authorization:** Backends are internal persistence adapters selected by hosts/framework configuration, not end-user entry points
- **Compatibility Strategy:** Strict shared contract across all official backends
- **Error model:** backend-specific errors normalized into `TuvrenError` persistence codes

```ts
// `BackendCapability` shape is specified in §3.7; see there for capability bits.
export interface RuntimeBackend {
  transact<T>(work: (tx: RuntimeBackendTx) => Promise<T>): Promise<T>;
  health(): Promise<{ ok: true } | { ok: false; reason: string }>;
  capabilities(): BackendCapability;
}

export interface ObjectRepository {
  get(hash: HashString): Promise<StoredObject | null>;
  has(hash: HashString): Promise<boolean>;
  put(record: StoredObject): Promise<void>;
}

export interface SchemaRepository {
  get(schemaId: string): Promise<StoredSchema | null>;
  put(record: StoredSchema): Promise<void>;
}

export interface TurnTreeRepository {
  get(hash: HashString): Promise<StoredTurnTree | null>;
  put(record: StoredTurnTree): Promise<void>;
}

export interface TurnTreePathRepository {
  get(
    turnTreeHash: HashString,
    path: string,
  ): Promise<StoredTurnTreePath | null>;
  listByTurnTree(turnTreeHash: HashString): Promise<StoredTurnTreePath[]>;
  putMany(records: StoredTurnTreePath[]): Promise<void>;
}

export interface OrderedPathChunkRepository {
  get(chunkHash: HashString): Promise<StoredOrderedPathChunk | null>;
  put(record: StoredOrderedPathChunk): Promise<void>;
}

export interface TurnNodeRepository {
  get(hash: HashString): Promise<StoredTurnNode | null>;
  put(record: StoredTurnNode): Promise<void>;
}

export interface ThreadRepository {
  get(threadId: string): Promise<StoredThread | null>;
  put(record: StoredThread): Promise<void>;
  /**
   * Optional per BackendCapability descriptor (§3.7). Backends that
   * advertise `thread.enumeration: true` MUST implement this method.
   * Backends advertising `thread.enumeration: false` SHOULD NOT
   * implement it; the kernel never invokes it on those backends.
   *
   * Ordering is (createdAtMs ASC, threadId ASC). The `cursor` resumes
   * strictly after the (lastCreatedAtMs, lastThreadId) pair encoded
   * in the ListThreadsCursor payload (§3.8). The `filter.schemaId`
   * restricts to threads created with the matching schema id; an
   * absent filter returns all threads.
   */
  list?(options?: {
    limit?: number;
    cursor?: ListThreadsCursorPayload;
    filter?: { schemaId?: string };
  }): Promise<{
    threads: StoredThread[];
    nextCursor?: ListThreadsCursorPayload;
  }>;
}

export interface BranchRepository {
  get(branchId: string): Promise<StoredBranch | null>;
  listByThread(threadId: string): Promise<StoredBranch[]>;
  set(record: StoredBranch): Promise<void>;
}

export interface TurnRepository {
  get(turnId: string): Promise<StoredTurn | null>;
  set(record: StoredTurn): Promise<void>;
}

export interface RunRepository {
  get(runId: string): Promise<StoredRun | null>;
  listByBranch(branchId: string): Promise<StoredRun[]>;
  set(record: StoredRun): Promise<void>;
}

export interface StagedResultRepository {
  clearRun(runId: string): Promise<void>;
  get(runId: string, taskId: string): Promise<StoredStagedResult | null>;
  listByRun(runId: string): Promise<StoredStagedResult[]>;
  set(record: StoredStagedResult): Promise<void>;
}

export interface RuntimeBackendTx {
  objects: ObjectRepository;
  schemas: SchemaRepository;
  turnTrees: TurnTreeRepository;
  turnTreePaths: TurnTreePathRepository;
  orderedPathChunks: OrderedPathChunkRepository;
  turnNodes: TurnNodeRepository;
  threads: ThreadRepository;
  branches: BranchRepository;
  turns: TurnRepository;
  runs: RunRepository;
  stagedResults: StagedResultRepository;
}

export declare function createMemoryBackend(options?: {
  now?: () => EpochMs;
}): RuntimeBackend;
```

### 4.4 Provider Bridge Contract

- **Style:** library API
- **Authentication / Authorization:** Credentials stay in bridge configuration and host environment resolution; they are never persisted as core runtime state
- **Compatibility Strategy:** Tuvren Runtime owns the provider contract; the AI SDK bridge adapts to external package changes behind it
- **Error model:** Provider and bridge failures normalize into Tuvren provider errors with bridge-specific diagnostics
- **Structured-output dialects:** `StructuredOutputRequest.schema` defaults to JSON Schema draft-07 when `$schema` is absent. Draft-2019-09 and draft-2020-12 schemas are supported when the schema declares the matching `$schema` URI. Dynamic request schemas compile in isolated validator contexts so repeated `$id` values from different host requests do not collide across turns. Unsupported dialects, schema compilation failures, and data mismatches fail with `structured_output_validation`. `StructuredOutputRequest.strict` is not mapped generically by the baseline AI SDK bridge; `strict: true` fails fast as `invalid_ai_sdk_bridge_config` so the host must use explicit provider-specific options instead of relying on a silent no-op.
- **AI SDK baseline:** `@tuvren/provider-bridge-ai-sdk` adapts `LanguageModelV3` and `ProviderV3` from `@ai-sdk/provider@3.0.8`. The baseline bridge does not accept `LanguageModelV2`, AI SDK `ToolLoopAgent`, AI SDK UI messages, or AI SDK transport helpers as runtime inputs.
- **Bridge package ownership:** The bridge package owns all AI SDK imports, version-sensitive type guards, finish-reason conversion, usage conversion, prompt conversion, stream-part accumulation, and AI-SDK-specific error normalization. `@tuvren/runtime-api`, `@tuvren/provider-api`, ReAct, and `runtime-core` must not import AI SDK types.
- **Configuration mapping:** The bridge may read recognized call settings from `TuvrenPrompt.config.settings`: `maxOutputTokens`, `temperature`, `topP`, `topK`, `stopSequences`, `presencePenalty`, `frequencyPenalty`, `seed`, `toolChoice`, `headers`, and `providerOptions`. `TuvrenPrompt.signal` is an ephemeral cancellation control, not durable prompt content; when present, bridges must forward it to the underlying provider transport or SDK call and stop yielding chunks promptly once it aborts. Unsupported or malformed bridge settings fail with a `TuvrenProviderError` using code `invalid_ai_sdk_bridge_config`; unknown provider-native options must travel through the namespaced `providerOptions` object.
- **Prompt mapping:** Tuvren system, user, assistant, and tool messages map to `LanguageModelV3Prompt` messages. Tuvren `TextPart`, `ReasoningPart`, `FilePart`, `ToolCallPart`, and `ToolResultPart` map to the closest `LanguageModelV3*Part` shape without changing Tuvren durable content. User and assistant `StructuredPart` history is also accepted in the baseline bridge by serializing the parsed data back into JSON text for prompt replay. The baseline bridge replays only continuity-safe assistant content metadata back into AI SDK `providerOptions`: Anthropic reasoning `signature` / `redactedData`, Google or Vertex `thoughtSignature` on text, reasoning, or tool-call parts, and OpenAI/Azure `reasoningEncryptedContent`. Streamed reasoning continuity may still land as flat durable `providerMetadata.signature` because the shared stream seam only exposes a generic reasoning signature token; replay therefore uses active-provider heuristics for Anthropic or Google/Vertex ids, and arbitrary wrapper ids must persist namespaced metadata to avoid ambiguity. Assistant response-level metadata, synthetic `aiSdkBridge` metadata, request IDs, and other output-only namespaces are not replayed as prompt options. Tuvren tool definitions map to `LanguageModelV3FunctionTool`; provider-native and provider-mediated tools declared in `TuvrenPrompt.providerNativeTools`/`providerMediatedTools` map to `LanguageModelV3ProviderTool` entries alongside function tools (AY002/AY004).
- **Output mapping:** The baseline bridge maps `LanguageModelV3` text, reasoning, file, and client-executed tool-call content into canonical Tuvren content parts. Canonical generated text, reasoning, file, tool-call, and synthesized structured-output parts preserve AI SDK `providerMetadata` when the shared durable content seam exposes a matching field. Generate-mode tool calls synthesize framework-owned `callId` values and preserve the native AI SDK `toolCallId` under `providerMetadata.providerCallId`, matching the stream path’s durable shape. Structured output requested through `TuvrenPrompt.responseFormat` is synthesized from AI SDK JSON text output and validated before durable exposure, but intermediate `tool_call` turns remain valid when the provider finishes with `tool-calls` before any structured JSON text has been emitted. AI SDK `source`, response metadata, warnings, raw usage, and other metadata-bearing surfaces are preserved under `providerMetadata.aiSdkBridge`. Provider-executed tool calls, dynamic/provider-owned tools, `tool-result`, and `tool-approval-request` content are out of baseline scope and fail with typed bridge errors instead of widening shared runtime contracts.
- **Finish and usage mapping:** AI SDK finish reasons map as follows: `stop -> stop`, `tool-calls -> tool_call`, `length -> length`, `content-filter -> content_filter`, and `error | other -> error`. `LanguageModelV3Usage.inputTokens.total` maps to `ProviderUsage.inputTokens` and `LanguageModelV3Usage.outputTokens.total` maps to `ProviderUsage.outputTokens`; detailed usage such as cached, text, reasoning, raw, or provider-specific token counts is preserved under `providerMetadata`.
- **Streaming mapping:** `LanguageModelV3StreamResult.stream` is consumed as a `ReadableStream<LanguageModelV3StreamPart>` and exposed as Tuvren `ProviderStreamChunk` values. `text-start/text-delta/text-end` map to `text_delta`, or to synthesized `structured_delta` / `structured_done` when a structured response format is active. `reasoning-start/reasoning-delta/reasoning-end` map to reasoning chunks; Anthropic or Google/Vertex streamed reasoning continuity tokens flow through `reasoning_delta.signature`, and Anthropic `redacted_thinking` survives as a canonical redacted reasoning part through the existing finish metadata trail. `tool-input-start/tool-input-delta/tool-input-end` plus client-executed complete `tool-call` parts map to canonical `tool_call_*` chunks; `tool_call_done.providerMetadata` now carries provider-owned tool-call continuity metadata so streamed Gemini / Vertex tool turns can replay their history correctly. A structured-output turn may still finish with `tool-calls` before any structured JSON text is emitted. The bridge fails fast if the provider finishes the stream before every started tool call reaches `tool_call_done`. `finish` and `error` parts remain canonical. AI SDK `raw`, `stream-start`, `response-metadata`, and `source` parts are metadata-bearing inputs stored under finish metadata. Streamed `file`, `tool-result`, `tool-approval-request`, and provider-owned tool-governance parts are out of baseline scope and fail fast with bridge errors.

```ts
import type {
  LanguageModelV3,
  ProviderV3,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";

export interface TuvrenProvider {
  readonly id: string;
  generate(prompt: TuvrenPrompt): Promise<TuvrenModelResponse>;
  stream(prompt: TuvrenPrompt): AsyncIterable<ProviderStreamChunk>;
}

export interface AiSdkProviderBridgeOptions {
  id?: string;
  model: LanguageModelV3;
  defaultHeaders?: Record<string, string | undefined>;
  defaultProviderOptions?: SharedV3ProviderOptions;
}

export interface AiSdkProviderBridgeFromProviderOptions extends Omit<
  AiSdkProviderBridgeOptions,
  "model"
> {
  provider: ProviderV3;
  modelId: string;
}

export declare function createAiSdkProviderBridge(
  options: AiSdkProviderBridgeOptions,
): TuvrenProvider;

export declare function createAiSdkProviderBridgeFromProvider(
  options: AiSdkProviderBridgeFromProviderOptions,
): TuvrenProvider;

export interface StructuredOutputRequest {
  schema: JSONSchema;
  name?: string;
  strict?: boolean;
}

export interface TuvrenPrompt {
  messages: TuvrenMessage[];
  tools?: RenderedToolDefinition[];
  config?: TuvrenModelConfig;
  responseFormat?: StructuredOutputRequest;
  signal?: AbortSignal;
}

export type ProviderStreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; signature?: string }
  | { type: "reasoning_done" }
  | { type: "structured_delta"; delta: string }
  | { type: "structured_done"; data: unknown; name?: string }
  | { type: "tool_call_start"; providerCallId: string; name: string }
  | { type: "tool_call_args_delta"; providerCallId: string; delta: string }
  | {
      type: "tool_call_done";
      providerCallId: string;
      name: string;
      input: unknown;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "finish";
      finishReason:
        | "stop"
        | "tool_call"
        | "length"
        | "error"
        | "content_filter";
      usage?: { inputTokens: number; outputTokens: number };
      providerMetadata?: Record<string, unknown>;
    }
  | { type: "error"; error: unknown };
```

On normal stream completion, `finish` is only valid after any started structured-output or tool-call part has been completed by its corresponding `structured_done` or `tool_call_done` chunk. A final-only `structured_done` chunk is valid; the driver synthesizes the missing `structured.delta` from the final data before publishing `structured.done`, matching the generated-response event shape. Cancellation partial finalization is the only path that may preserve incomplete accumulated content.

### 4.5 Canonical Event Stream Contract

- **Style:** library API
- **Authentication / Authorization:** Controlled by the host embedding layer
- **Compatibility Strategy:** Existing event types and required fields are stable within a major version; minor releases may add event types or optional fields
- **Validator note:** Current-version stream validators reject undeclared fields so adapter drift fails fast. When a minor release adds an optional field, the same release must widen the validator allowlists accordingly.
- **Error model:** `error` events plus terminal `turn.end` where applicable

```ts
export interface EventSource {
  agent: string;
  driver?: string;
  workerId?: string;
  threadId?: string;
}

export type TuvrenStreamEvent =
  | {
      type: "turn.start";
      turnId: string;
      threadId: string;
      resumedFrom?: HashString;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "turn.end";
      turnId: string;
      status: "completed" | "paused" | "failed";
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "iteration.start" | "iteration.end";
      iterationCount: number;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "message.start";
      messageId: string;
      role: "assistant";
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "file.done";
      messageId: string;
      data: string | Uint8Array;
      filename?: string;
      mediaType: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "text.delta";
      messageId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "text.done";
      messageId: string;
      text: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "reasoning.delta";
      messageId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "reasoning.done";
      messageId: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "structured.delta";
      messageId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "structured.done";
      messageId: string;
      data: unknown;
      name?: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool_call.start";
      messageId: string;
      callId: string;
      name: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool_call.args_delta";
      callId: string;
      delta: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool_call.done";
      callId: string;
      name: string;
      input: unknown;
      providerMetadata?: Record<string, unknown>;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "message.done";
      messageId: string;
      finishReason:
        | "stop"
        | "tool_call"
        | "length"
        | "error"
        | "content_filter";
      usage?: { inputTokens: number; outputTokens: number };
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool.start";
      callId: string;
      name: string;
      input: unknown;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "tool.result";
      callId: string;
      name: string;
      output: unknown;
      isError?: boolean;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "approval.requested";
      request: ApprovalRequest;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "approval.resolved";
      response: ApprovalResponse;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "steering.incorporated";
      messageId: string;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "state.snapshot";
      manifest: ContextManifest;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "state.checkpoint";
      turnNodeHash: HashString;
      iterationCount: number;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "error";
      error: { message: string; code?: string; details?: unknown };
      fatal: boolean;
      timestamp: EpochMs;
      source?: EventSource;
    }
  | {
      type: "custom";
      name: string;
      data: unknown;
      timestamp: EpochMs;
      source?: EventSource;
    };
```

### 4.6 Driver Runtime Contract

- **Style:** library API
- **Authentication / Authorization:** Internal contract between shared runtime foundations and concrete driver implementations
- **Compatibility Strategy:** Breaking changes to driver execution entrypoints, driver result semantics, or registry ownership are semver-major because future drivers depend on this seam rather than on `runtime-core` internals
- **Error model:** Driver implementations return `RuntimeResolution` outcomes and may raise typed `TuvrenRuntimeError` failures for invalid driver behavior

```ts
export interface DriverRuntimePort {
  emit(event: TuvrenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

export interface DriverHandoffPort {
  createContextPlan(input: {
    targetAgent: string;
    reason: string;
    mode?: HandoffContextMode;
    builder?: HandoffContextBuilder;
    payload?: unknown;
  }): HandoffContextPlan;
}

export interface DriverExecutionContext {
  turnId: string;
  threadId: string;
  branchId: string;
  schemaId: string;
  iterationCount: number;
  config: Readonly<AgentConfig>;
  handoff: DriverHandoffPort;
  messages: ReadonlyArray<TuvrenMessage>;
  manifest: Readonly<ContextManifest>;
  toolRegistry: Readonly<ToolRegistry>;
  signal?: AbortSignal;
  runtime: DriverRuntimePort;
}

export interface DriverResumeContext extends DriverExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

export interface DriverExtensionStateUpdate {
  extensionName: string;
  state: Record<string, unknown>;
}

export interface DriverExecutionResult {
  assistantEventReconciliation?: "allow_final_sequence_divergence";
  resolution: RuntimeResolution;
  messages?: TuvrenMessage[];
  partial?: boolean;
  stateUpdates?: DriverExtensionStateUpdate[];
  toolExecutionMode?: "parallel" | "sequential";
}

export interface RuntimeDriver {
  readonly id: string;
  execute(context: DriverExecutionContext): Promise<DriverExecutionResult>;
  resume?(context: DriverResumeContext): Promise<DriverExecutionResult>;
}

export interface RuntimeDriverFactory {
  readonly id: string;
  create(): RuntimeDriver;
}

export interface DriverRegistry {
  register(driver: RuntimeDriver | RuntimeDriverFactory): void;
  resolve(driverId: string): RuntimeDriver | RuntimeDriverFactory | undefined;
  list(): Array<RuntimeDriver | RuntimeDriverFactory>;
}
```

`DriverExecutionResult` may contain at most one assistant message per iteration. `toolExecutionMode` is required when that assistant message requests tool calls and omitted otherwise. A failed `partial` result may still contain interrupted tool-call content; those calls are staged as durable context only and are not executed while the resolution remains failed. `stateUpdates` carries per-extension manifest updates collected by concrete driver-owned `aroundModel` execution so the shared core can apply them at the same checkpoint that commits the assistant message and manifest. `assistantEventReconciliation` is optional and reserved for explicit driver-signaled streaming cases such as `aroundModel` post-stream durable replacement. This keeps sequential-vs-parallel selection, extension-state durability, and narrow assistant-stream validation policy on the shared driver boundary instead of on runtime-core construction options. Approval resume remains framework-owned; any driver `resume(...)` method is optional and not part of the current shared-core execution path.

The current provider-neutral content contract does not define a dedicated
handoff content part inside `TuvrenModelResponse.parts`. Baseline Epic K
handoff preservation therefore remains on the existing shared driver seam:
concrete drivers return `RuntimeResolution.handoff` and build the associated
`HandoffContextPlan` through `DriverHandoffPort` when a higher layer or
provider-native integration has already identified a handoff. Provider-native
tool-like handoff detection remains a future bridge or contract concern and is
not introduced into the current provider-neutral content model in this pass.

Baseline ReAct also evaluates `AgentConfig.loopPolicy` during iteration
resolution composition. For assistant responses without executable tool calls,
`loopPolicy` may request either continuation or turn termination. For assistant
responses that do request executable tool calls, the current shared driver seam
requires `continue: true` and `executeTools: true`; any custom policy that
returns a non-continuing or non-executing decision for executable tool calls is
rejected as `invalid_loop_policy` rather than producing a partial or
terminal-with-tools driver result shape that the shared core does not support.

`runtime.emit(...)` is limited to driver-owned stream content and custom events. Framework-owned lifecycle events such as `turn.*`, `iteration.*`, `tool.*`, `approval.*`, `state.*`, and `error` remain shared-core responsibilities and are rejected if a driver tries to emit them directly. Shared core publishes driver-emitted content and custom events as they occur, while still retaining them for post-call validation and response synthesis. Because publication is live, already-forwarded driver events are not retracted if a later validation step fails, including post-stream structured-output validation; instead the turn terminates with the relevant contract error. If a driver emits assistant content events for a successful durable assistant response, that emitted assistant sequence must normally reconcile to the durable assistant message in `DriverExecutionResult.messages`, including incremental delta payloads such as `text.delta`, `reasoning.delta`, `structured.delta`, and `tool_call.args_delta`, stable event identity (`messageId`, `callId`), canonical message-start/message-done ordering, and the final `finishReason`; otherwise runtime-core rejects it as an invalid stream event. The one intentional exception is `aroundModel` post-stream response replacement: when an `aroundModel` wrapper has already allowed a live assistant sequence to stream via `next()` and then returns a different final durable response, the driver must return `assistantEventReconciliation: "allow_final_sequence_divergence"` so shared core validates the emitted assistant sequences as complete standalone assistant messages instead of requiring equality with the checkpointed durable assistant message. Shared core honors that exception only when the active agent config includes at least one `aroundModel` handler, assistant content events were actually emitted, the final emitted assistant sequence actually diverges from the durable assistant message, and neither side requests tools. In that divergence case, shared core still synthesizes the `AfterIterationContext.response` value from the durable assistant checkpoint so hook-visible `TuvrenModelResponse` values remain internally coherent even when the live stream differed. On terminal `fail` paths before a durable assistant message exists, emitted assistant content may remain as an interrupted partial sequence; shared core validates that sequence for allowed event shapes and ordering, but does not require durable-message equality in that failure case. When a driver returns a durable assistant message without emitting matching assistant content events, runtime-core synthesizes those missing assistant stream events from the durable message so the public stream and persisted history stay aligned.

### 4.7 Host Stream Adapter, Reference Host, and Hardening Contracts

- **Style:** library adapters plus local host harness
- **Authentication / Authorization:** Stream adapters and the playground do not implement product authentication. Hosts remain responsible for authenticating external callers before exposing runtime operations, provider credentials, or approval controls.
- **Compatibility Strategy:** `TuvrenStreamEvent` remains the canonical internal event vocabulary. Canonical stream semantics and SSE translation are portable runtime surfaces. Adapter packages translate outward and may add adapter-local metadata, but they must not change runtime event meaning, event order, stream single-consumer behavior, cancellation semantics, approval semantics, or durable state.
- **Error model:** Adapter failures normalize to typed adapter/runtime errors at the adapter boundary. They do not create kernel Runs, staged results, or synthetic provider events.

```ts
export type StreamProtocolAdapter<T> = (
  events: AsyncIterable<TuvrenStreamEvent>,
) => AsyncIterable<T>;

export interface StreamAdapterWarning {
  code: string;
  message: string;
  details?: unknown;
}

export interface StreamAdapterOptions {
  onWarning?: (warning: StreamAdapterWarning) => void;
}

export declare function teeTuvrenStreamEvents(
  events: AsyncIterable<TuvrenStreamEvent>,
  branchCount: number,
): readonly AsyncIterable<TuvrenStreamEvent>[];

export interface TuvrenSseFrame {
  event?: string;
  id?: string;
  data: string;
  retry?: number;
}

export declare function toSseFrames(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions,
): AsyncIterable<TuvrenSseFrame>;

export declare function toSseResponse(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions & ResponseInit,
): Response;

export declare function toAgUiEvents(
  events: AsyncIterable<TuvrenStreamEvent>,
  options?: StreamAdapterOptions,
): AsyncIterable<AGUIEvent>;
```

- `@tuvren/stream-core` owns shared adapter helpers: event cloning, tee/fanout for host or test multi-consumer flows, adapter-local warning projection, stream transform utilities, fixture helpers, and no-op pass-through transforms used by tests.
- `@tuvren/stream-sse` owns EventSource-compatible Server-Sent Events framing. Each SSE frame must preserve the original `TuvrenStreamEvent.type` as the default event name and serialize the complete canonical event as JSON in `data`.
- `@tuvren/stream-agui` owns AG-UI protocol translation. The baseline implementation is pinned to `@ag-ui/core@0.0.52` and uses its exported `AGUIEvent` union, `EventType`, and `EventSchemas` validator. Because AG-UI depends on an external SDK ecosystem, it remains an implementation-specific projection rather than a required cross-language portable surface. Tuvren-only semantics that AG-UI cannot represent directly must flow through a documented `CUSTOM` namespace instead of inventing first-class AG-UI state.
- Per ADR-041, `@tuvren/playground-host` is retired. The Reference Host is `@tuvren/repl-host`, the sole first-party proving host. Current repo reality removes `createPlaygroundKernelInspector` in favor of durable reads through `TuvrenRuntime` per ADR-036, deletes the playground package, renames REPL internals from `playground-*.ts` to `repl-*.ts`, and adds headless stdin, streaming JSONL, and transcript record/replay lanes.
- The Reference Host exercises the same high-level SDK surface offered to downstream hosts, proves durable reload and orchestration behavior end to end, lists threads and reads branch messages through the host-facing durable-read surface (never directly through the kernel), and avoids any private runtime shortcuts.
- The Reference Host supports two operating modes from one package and one command set: **interactive readline mode** (default) and **headless stdin mode** (activated by the `--headless` flag or `TUVREN_REPL_MODE=headless`). Headless mode reads stdin line-by-line, dispatches each non-empty line through `runReplInput(shell, line)` exactly as interactive mode does, and writes one JSON record per input/output pair to stdout. Headless mode exits on EOF or `.exit`. No script-file interpreter is provided; stdin is the input surface.
- The Reference Host supports **transcript capture** via `--record <path>` and **transcript replay** via `--replay <path>`. Transcript file format is JSONL with the schema in §3.9. Replay reconstructs a fresh runtime via `createTuvren({...})` using the backend choice recorded in the transcript header, replays each recorded input, and asserts equality between recorded and live outputs for deterministic record types; non-deterministic records (real provider responses) are captured-and-reported without assertion failure.
- The hardening line owns the extracted provider/framework testkits, release-check tooling, package export smoke tests, and explicit portability-matrix validation for clearly portable core non-native packages across Bun and Node. Historical closure detail from Epic Q and later support work may remain available for audit, but it must not substitute for current proving-host or portability-gate evidence. Deno checks remain deferred until package surfaces stabilize enough to avoid testing scaffolding churn.

### 4.8 Boundary-Owned Contract and Conformance Asset Surface

- **Style:** mixed machine-readable artifact surface
- **Authentication / Authorization:** Not a runtime auth boundary. These assets are repo-owned and reviewed through normal source-control and CI policy.
- **Compatibility Strategy:** Each boundary owns its own contract, conformance, and artifact outputs. Shape contracts, behavioral fixtures, and generated artifacts may version independently, but none may silently contradict the human semantic sources.
- **Error model:** Validation, generation, or suite-shape failures stop CI or local verification and do not count as runtime behavior.

```text
boundaries/<area>/contracts/<surface>/
  spec/
    typespec/        # when TypeSpec is the authored contract source
    cddl/            # when CDDL is the authored record-grammar source
  artifacts/
    json-schema/
    openapi/
  src/
  test/

boundaries/<area>/conformance/
  schemas/
  fixtures/
  scenarios/
```

- TypeSpec is the preferred authored source for framework- and provider-facing machine-readable shape contracts when a contract package is promoted to that level.
- Kernel protocol record grammar is authored under `boundaries/kernel/contracts/protocol/spec/cddl/`.
- Conformance fixture schemas use JSON Schema 2020-12 and validate language-neutral fixtures and scenarios.
- Conformance suite manifests must mature from listing fixtures to listing named semantic checks, their fixture or scenario inputs, required assertions, expected evidence fields, and implementation-runner applicability.
- High-value semantics currently proven only in TypeScript package tests must be triaged as one of: promoted to boundary-owned conformance, intentionally implementation-specific, deferred with a named rationale, or obsolete.
- Generated contract artifacts such as JSON Schema, OpenAPI, and compatibility reports may be checked in when they are useful reviewed outputs.
- Generated implementation bindings should generally not be checked in; when they are, they belong under the consuming implementation tree.

### 4.9 Kernel Interop Transport Contract

- **Style:** gRPC/RPC
- **Authentication / Authorization:** The interop transport is an internal runtime boundary. Any external authentication remains host-owned when the transport is exposed beyond local development or CI.
- **Compatibility Strategy:** The first interop surface is kernel-only, versioned independently from npm package or future crate versions, and governed mechanically through Buf lint and breaking-change checks once `.proto` files are introduced. Buf `FILE` compatibility is the required default gate from the first `.proto` merge onward, and any relaxation requires an explicit future TechSpec revision rather than local convenience.
- **Error model:** Transport errors carry stable kernel/runtime error payloads rather than language-native exception types as the cross-process contract.

The first transport surface mirrors the kernel-only subsystem operations the
TypeScript framework already depends on through `RuntimeKernel`. It must
include the thread, branch, turn, and run lifecycle operations needed to
preserve the current `TuvrenRuntime` surface over a remote kernel path, while
keeping framework-owned `ExecutionHandle` controls such as `cancel()`,
`steer(...)`, `resolveApproval(...)`, and driver-loop execution out of the
kernel transport entirely.

```proto
service KernelThreadService {
  rpc ThreadCreate(ThreadCreateRequest) returns (ThreadCreateResponse);
  rpc ThreadGet(ThreadGetRequest) returns (ThreadGetResponse);
  // ADR-034: capability-gated thread enumeration. The remote kernel
  // returns a typed kernel_capability_unsupported error envelope
  // when the underlying backend does not advertise
  // thread.enumeration.
  rpc ThreadList(ThreadListRequest) returns (ThreadListResponse);
}

service KernelBranchService {
  rpc BranchCreate(BranchCreateRequest) returns (BranchCreateResponse);
  rpc BranchGet(BranchGetRequest) returns (BranchGetResponse);
  rpc BranchSetHead(BranchSetHeadRequest) returns (BranchSetHeadResponse);
  rpc BranchList(BranchListRequest) returns (BranchListResponse);
}

service KernelTurnService {
  rpc TurnCreate(TurnCreateRequest) returns (TurnCreateResponse);
  rpc TurnGet(TurnGetRequest) returns (TurnGetResponse);
  rpc TurnUpdateHead(TurnUpdateHeadRequest) returns (TurnUpdateHeadResponse);
}

service KernelRunService {
  rpc RunCreate(RunCreateRequest) returns (RunCreateResponse);
  rpc RunBeginStep(RunBeginStepRequest) returns (RunBeginStepResponse);
  rpc RunCompleteStep(RunCompleteStepRequest)
      returns (RunCompleteStepResponse);
  rpc RunComplete(RunCompleteRequest) returns (RunCompleteResponse);
  rpc RunRecover(RunRecoverRequest) returns (RunRecoverResponse);
}
```

- Authored `.proto` files live under `boundaries/kernel/interop/grpc/proto/`.
- Event envelopes and stable error payloads are part of the transport surface where real cross-process execution needs them.
- Path values, verdicts, and staged-result outcomes must preserve the kernel
  contract's union semantics in Protobuf with `oneof` envelopes rather than
  parallel optional fields.
- The interop surface must stay narrower than the full framework API during the first Rust phase and must not absorb host or driver-owned control semantics in order to make the remote kernel path convenient.

### 4.10 Compatibility Ledger Contract

- **Style:** generated JSON report
- **Authentication / Authorization:** None. This is a repo-generated report artifact.
- **Compatibility Strategy:** The ledger records measured implementation parity by suite and version. It is designed as a conservative, reviewable near-public readiness signal, not merely a private maintainer scratchpad.
- **Determinism note:** Because the ledger is checked in, `generatedAtMs` and `sourceRevision` use stable sentinel metadata inside the JSON payload; Git history remains the authoritative record for when and from which revision that evidence entered the repo.
- **Error model:** Missing, stale, or contradictory suite results are report-generation failures, not silent compatibility claims.

```json
{
  "generatedAtMs": 0,
  "sourceRevision": "checked-in-workspace",
  "suites": [
    {
      "suiteId": "",
      "suiteVersion": "",
      "boundary": ""
    }
  ],
  "implementations": [
    {
      "implementationId": "",
      "language": "",
      "version": "",
      "results": [
        {
          "checkIds": [""],
          "checkSummary": {
            "applicableChecks": 1,
            "failedChecks": 0,
            "passedChecks": 1,
            "totalChecks": 1
          },
          "suiteId": "",
          "suiteVersion": "",
          "status": "pass",
          "reportStatus": "full_pass",
          "evidencePath": ""
        }
      ]
    }
  ],
  "interop": [
    {
      "pairId": "",
      "checkIds": [""],
      "checkSummary": {
        "applicableChecks": 1,
        "failedChecks": 0,
        "passedChecks": 1,
        "totalChecks": 1
      },
      "suiteId": "",
      "suiteVersion": "",
      "status": "pass",
      "reportStatus": "full_pass",
      "evidencePath": ""
    }
  ]
}
```

- `reports/compatibility/compatibility-matrix.json` is generated from actual conformance and interop-smoke runs.
- The ledger must answer whether a named implementation passes a named suite version, whether a named cross-language pairing passes its interop-smoke suite, and which evidence artifact supports each claim.
- Every implementation and interop result must name the executed `checkIds` and a `checkSummary` so reviewers can distinguish check-level semantic evidence from coarse suite success.
- Raw `status` is exactly `pass`, `fail`, `unsupported`, or `not_applicable`.
- `pass` requires `applicableChecks > 0`, `failedChecks === 0`, and `passedChecks === applicableChecks`.
- `fail` means `failedChecks > 0`.
- `unsupported` means the implementation advertises no capabilities required by the suite, while the suite is otherwise relevant to that implementation boundary.
- `not_applicable` means the suite does not target the implementation boundary, surface, or authority packet.
- `status: "pass"` with `applicableChecks === 0` is invalid and must fail report generation.
- `reportStatus` may remain as a presentation/classification field such as `full_pass`, `partial`, `unsupported`, or `not_applicable`, but it must not contradict raw `status`.
- A raw `pass` status is necessary but not sufficient for TypeScript readiness or future implementation-line activation. Sufficiency is defined by the active staged gates from ADR-033 and `§5.4`: product-proof evidence, platform evidence, portability evidence, and any current clean-checkout verification checks named by the live build sequence.
- Ledger wording must stay conservative and measured enough that the file can move toward external readiness signaling without later semantic cleanup.

### 4.11 Authority Packet Manifest Contract

- **Style:** boundary-owned JSON manifest validated by JSON Schema 2020-12
- **Authentication / Authorization:** None. The manifest is reviewed source under normal repo policy.
- **Compatibility Strategy:** Per the §2.1 authority-packet compatibility rule. Adding declared sources, generated artifacts, plans, or binding projections is minor; removing a declared authoritative source, removing a referenced conformance plan, or relaxing a declared forbidden authority source is major.
- **Error model:** Manifest-validation failures, missing declared sources, unreachable generated artifacts, undeclared generated outputs, and references to declared forbidden authority sources stop CI through the §ADR-027 freshness gate.

The manifest lives at `boundaries/<area>/contracts/<surface>/spec/authority-packet.json` for contract surfaces, and at `boundaries/<area>/conformance/spec/authority-packet.json` or `boundaries/<area>/interop/<channel>/spec/authority-packet.json` for behavior-rooted or interop-rooted surfaces. Each manifest validates against the JSON Schema below, which lives at `tools/schemas/authority-packet.schema.json`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://tuvren.dev/schemas/authority-packet.schema.json",
  "type": "object",
  "required": [
    "packetId",
    "version",
    "boundary",
    "surface",
    "authoritativeSources",
    "forbiddenAuthoritySources",
    "verificationPaths"
  ],
  "additionalProperties": false,
  "properties": {
    "packetId": {
      "type": "string",
      "pattern": "^tuvren\\.[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$"
    },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "boundary": {
      "type": "string",
      "enum": ["framework", "kernel", "providers", "shared", "hosts", "telemetry"]
    },
    "surface": { "type": "string", "minLength": 1 },
    "humanAuthorityRefs": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "default": []
    },
    "authoritativeSources": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["path", "format"],
        "additionalProperties": false,
        "properties": {
          "path": { "type": "string", "minLength": 1 },
          "format": {
            "type": "string",
            "enum": [
              "typespec",
              "cddl",
              "proto",
              "json-schema",
              "conformance-plan",
              "semconv-yaml",
              "fixture-set"
            ]
          }
        }
      }
    },
    "generatedArtifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["path", "generatedFrom"],
        "additionalProperties": false,
        "properties": {
          "path": { "type": "string", "minLength": 1 },
          "generatedFrom": { "type": "string", "minLength": 1 },
          "generator": { "type": "string", "minLength": 1 }
        }
      },
      "default": []
    },
    "conformancePlans": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["planId", "planVersion", "path"],
        "additionalProperties": false,
        "properties": {
          "planId": { "type": "string", "minLength": 1 },
          "planVersion": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
          "path": { "type": "string", "minLength": 1 }
        }
      },
      "default": []
    },
    "bindingProjections": {
      "type": "object",
      "additionalProperties": { "type": "string", "minLength": 1 },
      "default": {}
    },
    "bindingAppendices": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["language", "path"],
        "additionalProperties": false,
        "properties": {
          "language": { "type": "string", "minLength": 1 },
          "path": { "type": "string", "minLength": 1 }
        }
      },
      "default": []
    },
    "forbiddenAuthoritySources": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1 }
    },
    "verificationPaths": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["kind", "target"],
        "additionalProperties": false,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "schema-validation",
              "openapi-validation",
              "conformance-plan",
              "interop-smoke",
              "freshness-check",
              "vocabulary-check"
            ]
          },
          "target": { "type": "string", "minLength": 1 }
        }
      }
    },
    "freshnessChecks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["artifact", "regenerateCommand"],
        "additionalProperties": false,
        "properties": {
          "artifact": { "type": "string", "minLength": 1 },
          "regenerateCommand": { "type": "string", "minLength": 1 }
        }
      },
      "default": []
    }
  }
}
```

- `humanAuthorityRefs` lists rationale documents (such as `docs/KrakenKernelSpecification.md` sections) that the packet projects but does not depend on for executable verification.
- `forbiddenAuthoritySources` always includes at minimum every implementation-language root that contributes binding projections for the surface, plus `README.md`, `docs`, and `constitution` paths that historically described it. Per ADR-023 and ADR-024, those are explicit forbidden authority sources for cross-language semantics carried by this packet, not forbidden source files.
- Every binding-language projection root listed under `bindingProjections` must also appear in `forbiddenAuthoritySources` (the projection is a downstream of the packet, not authority for it).
- `verificationPaths` must include at least one `schema-validation`, `openapi-validation`, `conformance-plan`, `interop-smoke`, or `vocabulary-check` kind. A packet with only `freshness-check` entries is not yet executable authority and must be marked with `version` `0.0.x` until at least one executable verification path lands. `openapi-validation` validates an emitted OpenAPI artifact against the OpenAPI specification; `interop-smoke` exercises a cross-implementation transport path through an interop-smoke target named by the surface's Nx project; `vocabulary-check` asserts that every identifier in the named vocabulary source (for example, a semantic-convention YAML) round-trips into every generated artifact declared by the packet so the cross-language vocabulary cannot drift between languages. All five kinds count as executable verification for packets that own a corresponding emitted artifact, interop seam, or vocabulary source.

### 4.12 Conformance Plan Contract

- **Style:** boundary-owned JSON document validated by JSON Schema 2020-12
- **Authentication / Authorization:** None. Plans are reviewed source under normal repo policy.
- **Compatibility Strategy:** Plans use `planVersion` independent of npm/crate versions. Adding new checks or new applicable capabilities is minor; removing a check or tightening an existing assertion is major.
- **Error model:** Plan-loading failures, schema validation failures against the plan schema, and unresolved `$ref`s to fixtures or scenarios stop CI before any adapter executes.

A conformance plan is data-owned per ADR-025. Plans live alongside the surface they verify under `boundaries/<area>/conformance/plans/<plan-id>.json` (or under a sibling `interop/<channel>/plans/` directory for interop-rooted plans). Plans validate against `tools/schemas/conformance-plan.schema.json`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://tuvren.dev/schemas/conformance-plan.schema.json",
  "type": "object",
  "required": [
    "planId",
    "planVersion",
    "packetId",
    "applicability",
    "checks"
  ],
  "additionalProperties": false,
  "$defs": {
    "assertion": {
      "type": "object",
      "required": ["kind"],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "resultField",
            "eventSequence",
            "terminalEvent",
            "schemaValid",
            "errorEnvelope",
            "stateField",
            "evidenceField",
            "ordering",
            "noEvent"
          ]
        },
        "path": { "type": "string", "minLength": 1 },
        "schema": { "type": "string", "minLength": 1 },
        "equals": {},
        "equalsPath": { "type": "string", "minLength": 1 },
        "matches": { "type": "string", "minLength": 1 },
        "contains": {},
        "containsPath": { "type": "string", "minLength": 1 },
        "field": { "type": "string", "minLength": 1 },
        "eventType": { "type": "string", "minLength": 1 }
      }
    }
  },
  "properties": {
    "planId": { "type": "string", "minLength": 1 },
    "planVersion": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "packetId": { "type": "string", "minLength": 1 },
    "applicability": {
      "type": "object",
      "required": ["capabilities"],
      "additionalProperties": false,
      "properties": {
        "capabilities": {
          "type": "array",
          "minItems": 1,
          "items": { "type": "string", "minLength": 1 }
        }
      }
    },
    "fixtures": {
      "type": "object",
      "additionalProperties": { "type": "string", "minLength": 1 },
      "default": {}
    },
    "checks": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["checkId", "operation", "assertions"],
        "additionalProperties": false,
        "properties": {
          "checkId": { "type": "string", "minLength": 1 },
          "operation": { "type": "string", "minLength": 1 },
          "capabilities": {
            "type": "array",
            "items": { "type": "string", "minLength": 1 },
            "default": []
          },
          "fixture": { "type": "string", "minLength": 1 },
          "scenario": { "type": "string", "minLength": 1 },
          "input": {},
          "controls": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "deadlineMs": { "type": "integer", "minimum": 1 },
              "cancelAfterEvent": { "type": "string", "minLength": 1 }
            }
          },
          "assertions": {
            "type": "array",
            "minItems": 1,
            "items": { "$ref": "#/$defs/assertion" }
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["stepId", "operation"],
              "additionalProperties": false,
              "properties": {
                "stepId": { "type": "string", "minLength": 1 },
                "operation": { "type": "string", "minLength": 1 },
                "input": {},
                "controls": {},
                "assertions": {
                  "type": "array",
                  "minItems": 1,
                  "items": { "$ref": "#/$defs/assertion" }
                },
                "inspectState": {}
              }
            },
            "default": []
          },
          "evidence": {
            "type": "array",
            "items": { "type": "string", "minLength": 1 },
            "default": []
          }
        }
      }
    }
  }
}
```

- `operation` is a neutral operation name resolved by the Implementation Adapter Protocol (§4.13). The plan never names a TypeScript function or a Rust trait method directly; it names the neutral operation declared by the authority packet.
- `applicability.capabilities` and `checks[].capabilities` are executable. The shared runner selects checks by intersecting plan-required capabilities with capabilities declared by the adapter manifest or initialization response; promoted plans must not select by implementation ID, language, runner name, or adapter name.
- `assertions[].kind` covers decisive result observations (`resultField` over `$.result`), durable state (`stateField` over `$.state`), event-stream behavior (`eventSequence`, `terminalEvent`, `ordering`, and `noEvent` over `$.events`), shape (`schemaValid` over `$.result`, `$.events`, or `$.state`, plus `errorEnvelope`), and diagnostics (`evidenceField` over `$.evidence`).
- Decisive assertion kinds are `resultField`, `stateField`, `eventSequence`, `terminalEvent`, `schemaValid` over `$.result` / `$.events` / `$.state`, `errorEnvelope`, `ordering`, and `noEvent`. A conformance plan referenced by an Authority Packet must reject any promoted check that lacks at least one decisive non-evidence assertion.
The decisive-assertion requirement applies across both `checks[].assertions` and `checks[].steps[].assertions`. A lifecycle check may satisfy the requirement through step assertions, final trace assertions, or both, but no promoted check or promoted trace step may rely only on evidence assertions.
- `evidenceField` is never decisive. `schemaValid` over `$.evidence` is diagnostic and cannot satisfy the decisive-assertion requirement.
- `noEvent` must inspect the runner-owned event observation stream, not adapter evidence arrays or adapter-reported event-type summaries.
- The shared semantic runner implements assertion kinds once; product-specific assertion logic must be expressed through these operators rather than added as runner-side or adapter-side bespoke code.
- `equalsPath` and `containsPath` resolve against the runner-owned assertion context (`$.input`, `$.fixture`, `$.scenario`, `$.result`, `$.events`, `$.state`, and `$.evidence`) so plans can compare raw observations to fixture or prior-step values without moving comparison logic into adapters.
- `controls` covers cancellation injection and deadlines; additional generic mechanics may be added through capability selectors and adapter-declared capabilities rather than by hard-coding new control semantics in runner or adapter source.
- `evidence[]` lists the evidence artifact paths the runner must emit for the Compatibility Reporting Boundary; missing required evidence is a check failure.
- `steps[]` is the trace-plan extension for lifecycle-heavy behavior. Each step names a neutral operation, optional per-step input, optional controls, optional per-step assertions, and optional state inspection query. The shared runner executes steps against one adapter instance when the adapter supports lifecycle handles, stores each step's assertion context under `$.state.trace.<stepId>` and `$.evidence.trace.<stepId>`, resolves prior-step references before dispatch, and evaluates final check assertions over the assembled trace. Adapters still receive no `checkId` and own no assertion semantics.

### 4.13 Implementation Adapter Protocol

- **Style:** process-level adapter host protocol, with JSON-RPC 2.0 over stdio as the normative transport target
- **Authentication / Authorization:** Internal verification surface; adapters are not external entry points.
- **Compatibility Strategy:** Protocol-shaped contract under `tools/conformance/adapter-protocol/`. Breaking changes to the operation, event, cancellation, error envelope, or state-inspection seam require a major-version bump and a coordinated update across every implementation adapter the surface declares in its authority packet.
- **Error model:** Adapter/protocol failures are isolated from implementation result errors. A JSON-RPC transport or adapter failure returns an adapter error envelope and must not populate `$.result.error`; implementation-produced error behavior appears only inside a successful neutral observation returned by the native implementation path.

The adapter protocol is the neutral seam between the shared Semantic Conformance Runner and any one Implementation Adapter Host. It is intentionally minimal so that adding a new language line means writing a new adapter host and binding projection, not a new assertion engine or conformance suite. JSON-RPC 2.0 requires request/response objects to carry `jsonrpc: "2.0"`, correlates responses by `id`, and keeps success `result` mutually exclusive with error `error`; the Tuvren protocol uses that envelope while defining its own neutral methods and observation payloads.

```text
ConformanceAdapterHost (neutral protocol)

  initialize(packetId, planVersion) -> AdapterCapabilities
  createInstance(input?) -> InstanceHandle | null
  shutdown() -> void

  dispatch(operation, input, controls) -> OperationOutcome
    OperationOutcome ::=
      | { kind: "result", value: Observation }
      | { kind: "error",  error: AdapterErrorEnvelope }

  events(operation, input, controls, instance?) -> JsonValue[]
    Events returns any additional neutral events observed after dispatch.
    Event-stream implementation checks should normally return implementation
    events directly in Observation.events from dispatch so the runner can assert
    the actual native stream.

  inspectState(query, instance?) -> StateView | null
    StateView is a JSON-encodable projection of durable state declared inspectable by the authority packet

  destroyInstance(instanceHandle) -> void

Observation ::= {
  result?: JsonValue,
  events?: JsonValue[],
  state?: JsonValue,
  evidence?: JsonValue,
  diagnostics?: JsonValue
}

AdapterErrorEnvelope ::= { code: string, message: string, details?: JsonValue, cause?: AdapterErrorEnvelope }
```

- Operations are named by the authority packet, not by a TypeScript or Rust signature. The same operation name resolves to the language-native call inside the adapter.
- `Observation.result`, `Observation.events`, and `Observation.state` are the only semantic observation domains. `Observation.evidence` and `Observation.diagnostics` are diagnostic/provenance domains only.
- Adapter hosts do not receive `checkId`, do not emit check-scoped evidence, and do not decide pass/fail. The shared runner maps raw observations to required evidence paths and assertion results.
- Promoted implementation adapters must not return semantic verdict fields through evidence, including fields equivalent to `passed`, `matches`, `valid`, `verified`, or any check-result proxy.
- Promoted implementation adapters must not import semantic verifier/assertion helpers whose job is to decide whether expected runtime semantics matched. Expected behavior belongs in conformance plans and must be evaluated by the shared runner.
- Promoted framework conformance must not depend on implementation-local `/test/` harnesses as the main proof path unless that harness is promoted as an explicit boundary-owned testkit with a bounded contract.
- Event observations are ordered neutral event arrays; per ADR-025 the runner asserts the event sequence rather than the adapter implementing the expected sequence.
- Cancellation and deadlines are control inputs, not derived from `AbortSignal` or a Rust cancellation token at the protocol level. Adapters bridge to language-native cancellation internally.
- Byte payloads cross the seam as base64-encoded JSON strings or as opaque JSON values; the adapter is responsible for converting to or from `Uint8Array`, `Buffer`, `Vec<u8>`, or any other language-native byte container.
- `inspectState` and instance lifecycle methods are optional per packet. Packets that do not declare an inspectable or stateful surface omit them; packets that declare them list the queryable views and lifecycle requirements in the manifest or plan metadata.

### 4.14 Schema Authoring Helper

- **Style:** library API
- **Authentication / Authorization:** Not applicable; pure host-side authoring surface
- **Compatibility Strategy:** Adding a new supported schema authoring kind is semver-minor; changing detection precedence is semver-major because it can change which adapter validates a given schema; removing a supported schema kind is semver-major
- **Error model:** `TuvrenValidationError` codes `invalid_tool_schema_authoring` (detection failed; no precedence branch matched) and `tool_input_validation_failed` (validation rejected an input at execute time)

```ts
import type {
  ToolExecutionContext,
  TuvrenToolDefinition,
  TuvrenJsonSchema,
  ApprovalPolicy,
} from "@tuvren/core/tools";
import type { TuvrenValidationError } from "@tuvren/core/errors";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const schemaSymbol = Symbol.for("tuvren.schema");

export interface Schema<T = unknown> {
  readonly [schemaSymbol]: true;
  readonly _type: T;                                   // brand only; never read at runtime
  readonly jsonSchema: TuvrenJsonSchema;
  readonly validate?: (
    value: unknown,
  ) =>
    | { success: true; value: T }
    | { success: false; error: TuvrenValidationError };
}

// Re-exports from the source library when the host has it installed.
// The library is an optional peerDependency; types resolve via the
// peerDependency without requiring the runtime to import the source
// library directly.
export type ZodSchema<T = unknown> =
  | import("zod/v3").Schema<T, import("zod/v3").ZodTypeDef, unknown>
  | import("zod/v4").ZodType<T>;

export type StandardSchema<T = unknown> = StandardSchemaV1<unknown, T>;

export type LazySchema<T = unknown> = () => FlexibleSchema<T>;

export type FlexibleSchema<T = unknown> =
  | Schema<T>
  | ZodSchema<T>
  | StandardSchema<T>
  | LazySchema<T>
  | TuvrenJsonSchema;                                 // legacy bare-JSON-Schema path; T = unknown

// Detection precedence (ADR-038): wrapped (schemaSymbol) → Zod v4
// (_zod) → Standard Schema with vendor !== "zod" → Standard Schema
// with vendor === "zod" → lazy function → bare TuvrenJsonSchema
export declare function asSchema<T>(schema: FlexibleSchema<T>): Schema<T>;

export declare function jsonSchema<T = unknown>(
  schema: TuvrenJsonSchema,
  options?: {
    validate?: Schema<T>["validate"];
  },
): Schema<T>;

export declare function zodSchema<T>(schema: ZodSchema<T>): Schema<T>;

export declare function standardSchema<T>(
  schema: StandardSchema<T>,
): Schema<T>;

export declare function defineTool<INPUT, OUTPUT>(options: {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<INPUT>;
  execute: (
    input: INPUT,
    context: ToolExecutionContext,
  ) => Promise<OUTPUT> | OUTPUT;
  approval?: ApprovalPolicy;
  timeout?: number;
  metadata?: Record<string, unknown>;
}): TuvrenToolDefinition;
```

- `defineTool` returns a `TuvrenToolDefinition` whose `inputSchema` field carries the normalized `CustomSchema` shape that the Tool Execution Gateway has always accepted. The normalization runs once at `defineTool` time, not on every tool invocation.
- The boundary `CustomSchema` contract (§4.1's `TuvrenToolDefinition.inputSchema: TuvrenJsonSchema | CustomSchema`) is preserved unchanged; raw JSON Schema and the existing `CustomSchema` interop shape remain legal at the contract seam, but they produce `unknown` input types in the `execute` callback. Type inference only flows when the helper recognizes one of the wrapped schema kinds.
- `zod` and `@standard-schema/spec` are optional `peerDependencies` of `@tuvren/core` declared as `peerDependenciesMeta.<name>.optional = true`. Hosts that do not author tools through these libraries do not install them.

### 4.15 MCP Client Container

- **Style:** library API plus external protocol client
- **Authentication / Authorization:** Carried in the `McpAuth` discriminated union: bearer tokens or arbitrary header pairs. The external MCP server boundary is untrusted (Architecture §1.3); the host is responsible for authentication choices.
- **Compatibility Strategy:** The `createMcpToolSource` signature and the `McpToolSource` interface follow semver. Bumping the upstream `@modelcontextprotocol/sdk` to a new minor that maintains protocol compatibility is internal and does not require a `@tuvren/mcp-client` major. Bumping the SDK to a new MCP protocol major requires a `@tuvren/mcp-client` major.
- **Error model:** `TuvrenProviderError` codes `mcp_connection_failed`, `mcp_initialize_failed`, `mcp_tool_list_failed`, `mcp_tool_input_invalid`, `mcp_tool_output_invalid`, `mcp_tool_error`, `mcp_transport_failure`. Tool-level failures are surfaced as `ToolResultPart` with `isError: true` carrying the typed error in `output`.
- **Dependency note:** `@modelcontextprotocol/sdk@1.29.0` declares `zod` as a non-optional peer. `@tuvren/mcp-client` satisfies that upstream requirement with a direct `zod@4.4.3` dependency and keeps the public Tuvren peer surface limited to `@tuvren/core`.

```ts
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { TuvrenProviderError } from "@tuvren/core/errors";

export type McpTransport = "stdio" | "http-sse";

export type McpAuth =
  | { kind: "bearer"; token: string }
  | { kind: "header"; name: string; value: string };

export type McpTransportConfig =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: "http-sse";
      endpoint: string;
      headers?: Record<string, string>;
      auth?: McpAuth;
    };

export interface McpToolSource {
  readonly serverName: string;
  readonly tools: TuvrenToolDefinition[];
  refresh(): Promise<{ tools: TuvrenToolDefinition[] }>;
  close(): Promise<void>;
}

export interface CreateMcpToolSourceOptions extends McpTransportConfig {
  name?: string;                                  // tool-name prefix; default is server-advertised name
  onError?: (error: TuvrenProviderError) => void; // transport-level error sink
  toolNameSeparator?: string;                     // default "."
}

export declare function createMcpToolSource(
  options: CreateMcpToolSourceOptions,
): Promise<McpToolSource>;
```

- Tool translation rules: MCP `tool.name` → `TuvrenToolDefinition.name` prefixed by `${name}${toolNameSeparator}` when `name` is supplied; MCP `tool.description` → `TuvrenToolDefinition.description`; MCP `tool.inputSchema` (JSON Schema) → wrapped via `jsonSchema<unknown>(schema, { validate })` with Ajv-based validation; MCP advertised `outputSchema` (if present) is enforced on the result before surfacing; MCP `tool.annotations` are preserved under `TuvrenToolDefinition.metadata.mcp.annotations`.
- Both public transports (`stdio` and `http-sse`, with `http-sse` implemented by the SDK's non-deprecated Streamable HTTP transport) are exercised against the same conformance scenario set in `providers-mcp-client.json` to enforce behavioral parity (per Architecture §6 MCP transport fragmentation mitigation).
- The MCP server-side projection (exposing Tuvren as an MCP server) is explicitly out of scope and must not be added to `@tuvren/mcp-client`.

### 4.16 Batteries-Included Composition (`createTuvren`)

- **Style:** library API
- **Authentication / Authorization:** Not applicable
- **Compatibility Strategy:** Adding a new accepted `BackendKind` or `DriverKind` is semver-minor; removing one is semver-major. Changing the default `driver` is semver-major. Renaming a field on `CreateTuvrenOptions` is semver-major.
- **Error model:** `TuvrenValidationError` code `invalid_createtuvren_options` for malformed options, including conflicting duplicate configuration between top-level `telemetry` / `bounds` and their `runtimeOptions` aliases; backend-specific construction errors normalize through the backend's own error contract; MCP construction errors surface via `TuvrenProviderError`.

```ts
import type {
  TuvrenRuntime,
  OrchestrationRuntime,
  RuntimeWarning,
  ExecutionBounds,
} from "@tuvren/core/execution";
import type { TuvrenProvider } from "@tuvren/core/provider";
import type { TuvrenExtension } from "@tuvren/core/extensions";
import type { TuvrenTelemetrySink } from "@tuvren/core/telemetry";
import type { TuvrenToolDefinition } from "@tuvren/core/tools";
import type { RuntimeDriverFactory } from "@tuvren/core/driver";
import type { EpochMs } from "@tuvren/core";
// RuntimeKernel and RuntimeBackend are kernel-protocol types (not part of @tuvren/core)
import type { RuntimeKernel, RuntimeBackend } from "@tuvren/kernel-protocol";
import type { McpToolSource } from "@tuvren/mcp-client";

export type BackendKind = "memory" | "sqlite" | "postgres";
export type DriverKind = "react";

export interface MemoryBackendOptions {
  now?: () => EpochMs;
}

export interface SqliteBackendOptions {
  databasePath: string;
}

export interface PostgresBackendOptions {
  connectionString?: string;
  database?: string;
  host?: string;
  now?: () => EpochMs;
  password?: string;
  port?: number;
  schemaName?: string;
  username?: string;
}

export interface ReActDriverOptions {
  providerCallMode?: "stream" | "generate";
  toolExecutionMode?: "parallel" | "sequential";
}

export interface RuntimeWarning {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

// `RuntimeCoreOptions` keeps the `Core` suffix even though createTuvrenRuntimeCore was renamed
// to createTuvrenRuntime. This type is a public host-facing name (passed in CreateTuvrenOptions);
// renaming it would be a semver-major breaking change and is deferred to a future API cleanup.
// The actual RuntimeCoreOptions (in runtime-core/src/lib/runtime-core.ts) includes additional
// factory-managed fields: kernel, driverRegistry, defaultDriverId. createTuvren controls those
// internally and excludes them via the Omit below; hosts only ever configure the five public
// fields shown before the internal ones.
export interface RuntimeCoreOptions {
  defaultMaxParallelToolCalls?: number;
  manifestExtensionStateWarningBudgetBytes?: number | false;
  onWarning?: (warning: RuntimeWarning) => void;
  telemetry?: TuvrenTelemetrySink;
  bounds?: ExecutionBounds;
  /** @internal — managed by createTuvren */ kernel?: RuntimeKernel;
  /** @internal — managed by createTuvren */ driverRegistry?: unknown;
  /** @internal — managed by createTuvren */ defaultDriverId?: string;
}

export interface CreateTuvrenOptions {
  backend:
    | BackendKind
    | RuntimeBackend
    | { kind: "memory"; options?: MemoryBackendOptions }
    | { kind: "sqlite"; options: SqliteBackendOptions }
    | { kind: "postgres"; options: PostgresBackendOptions };
  driver?:
    | DriverKind
    | RuntimeDriverFactory
    | { kind: "react"; options?: ReActDriverOptions };
  provider?: TuvrenProvider;
  tools?: Array<TuvrenToolDefinition | McpToolSource>;
  extensions?: TuvrenExtension[];
  telemetry?: TuvrenTelemetrySink;
  bounds?: ExecutionBounds;
  /** Advanced: supply a pre-built kernel instead of letting the factory build one from `backend`. */
  kernel?: RuntimeKernel;
  runtimeOptions?: Omit<RuntimeCoreOptions, "kernel" | "driverRegistry" | "defaultDriverId">;
}

export interface TuvrenInstance {
  runtime: TuvrenRuntime;
  orchestration: OrchestrationRuntime;
  kernel: RuntimeKernel;
  provider?: TuvrenProvider;
  [Symbol.asyncDispose](): Promise<void>;
}

export declare function createTuvren(
  options: CreateTuvrenOptions,
): Promise<TuvrenInstance>;
```

- `telemetry` and `bounds` are convenience aliases for `runtimeOptions.telemetry` and `runtimeOptions.bounds`; supplying both top-level and nested copies of the same setting is invalid and surfaces `invalid_createtuvren_options`.
- `[Symbol.asyncDispose]` closes any `McpToolSource` references in `tools`, releases backend resources (closes the SQLite file handle, returns the PostgreSQL pool), and resolves any pending kernel work cleanly. Hosts using TC39 `using` syntax can write `await using tuvren = await createTuvren({ backend: "memory" });` for automatic cleanup.
- `provider` is optional; turns may pass per-call providers in `AgentConfig.model` instead.
- The `tools` array accepts both literal `TuvrenToolDefinition` arrays and `McpToolSource` references. MCP sources contribute their advertised `.tools` to the global registry at construction; the registry refreshes when a host calls `source.refresh()`.

### 4.17 Reference Host Headless Mode and Transcript Protocol

- **Style:** CLI surface plus durable on-disk file format
- **Authentication / Authorization:** Not built in; the host operator runs the binary directly. Transcripts contain whatever the operator entered, including any provider responses, and must be treated as sensitive on disk if they contain confidential data.
- **Compatibility Strategy:** Transcript file format follows §3.9 versioning. CLI flag additions are minor; renames are major. The headless input contract is line-delimited UTF-8 text (one input per `\n`-terminated line); changing this is major.
- **Error model:** Stdin parse failures produce structured error records to stdout (still one JSON object per line) and continue. Fatal failures (factory construction failed; transcript write failed) exit nonzero with a final structured error record.

```text
# CLI flags
--headless                        Activate headless stdin mode (default: interactive readline)
--record <path>                   Capture session transcript to <path> (JSONL); creates or truncates
--replay <path>                   Replay a captured transcript against a fresh runtime; exits with
                                  pass/fail report and nonzero status on assertion failure
--backend <memory|sqlite|postgres>     Backend choice (also TUVREN_REPL_BACKEND env)
--scenario <name>                 Run one scripted scenario then exit (legacy mode; preserved)

# Environment variables
TUVREN_REPL_MODE=headless         Equivalent to --headless
TUVREN_REPL_BACKEND               Equivalent to --backend
NO_COLOR / FORCE_COLOR            ANSI color control (interactive mode only)
```

- Headless output: one JSON object per line on stdout. By default, each object is a `TranscriptOutputRecord` (§3.9). When `--stream-jsonl` is enabled, canonical `TranscriptStreamEventRecord` objects are also emitted to stdout before the corresponding output record. Errors are emitted as `TranscriptOutputRecord` with `output: null` and an additional `error` field carrying a structured error description; the next input is still processed.
- Recording: while `--record <path>` is active, the same input/output pairs that drive interactive or headless dispatch are also written as `TranscriptInputRecord` + zero-or-more `TranscriptStreamEventRecord` + `TranscriptOutputRecord` + zero-or-more `TranscriptDurableReadRecord` to `<path>`. The header is written before the first input arrives.
- Recording limitation: `--record` is only supported when the backend is specified by `BackendKind` string or kind-tagged object (`{ kind, options }`), because the transcript header encodes `config.backend` as `{ kind: BackendKind; options?: unknown }`. Starting the REPL with a pre-built `RuntimeBackend` instance is unsupported for recording; the host process must reject `--record` at startup if a raw `RuntimeBackend` was passed to `createTuvren`.
- Replay: reads the transcript file, validates the header, rehydrates any credential-bearing backend options from `header.config.backend.credentialSource` and host-supplied secrets when required, constructs a fresh runtime via `createTuvren({ backend: hydratedBackendConfig })`, and replays each `TranscriptInputRecord` in order. For deterministic record types (any input that produced only `TranscriptOutputRecord`/`TranscriptStreamEventRecord`/`TranscriptDurableReadRecord` from a deterministic provider mode like `aimock-*` or `fixture`, plus deterministic REPL commands such as `.status`, `.thread new`, `.thread show`, and `.messages show` regardless of provider mode), the replay asserts equality between recorded and live outputs and fails on mismatch. For non-deterministic record types (real provider/freeform responses identified by `header.config.providerMode` being one of `ai-sdk-google`, `ai-sdk-openai`, `ai-sdk-anthropic`, or equivalent non-deterministic provider modes), the replay captures the live output but does not assert equality; the final replay report distinguishes deterministic-asserted from non-deterministic-recorded records.

### 4.18 Operational Telemetry Surface

- **Style:** library API (sink interface) plus an implementation-specific export adapter
- **Ownership:** `@tuvren/core/telemetry` owns the `TuvrenTelemetrySink` interface, `NoopTelemetrySink`, and the `TelemetrySpan` / `TelemetryEvent` / `TelemetryLineage` record types (§3.10). `@tuvren/runtime` owns emission wiring and the curated re-export surface. `@tuvren/telemetry-otel` owns the OpenTelemetry projection.
- **Compatibility Strategy:** The sink interface and record shapes are semver-governed (§2.1 operational telemetry compatibility). The canonical telemetry vocabulary is the authored semconv source and versions independently. The OTel projection is an ecosystem-specific surface and is not part of the portable cross-language contract.
- **Error model:** A sink that throws is isolated by the runtime: the failure is caught, one internal warning is logged, and execution proceeds. Telemetry never fails a turn.

```ts
export interface TuvrenTelemetrySink {
  span(span: TelemetrySpan): void;
  event(event: TelemetryEvent): void;
}

export declare const NoopTelemetrySink: TuvrenTelemetrySink;
```

- The runtime emits to the configured sink at: turn/run start and end, iteration boundaries, model request/response, tool call start/end and approval transitions, checkpoint commit, recovery resume-or-fail, bounded-execution stop (ADR-043), and errors. Emission reuses the canonical event vocabulary so the telemetry surface and the event stream cannot diverge.
- `createTuvren({ telemetry })` accepts a sink; when omitted the runtime uses `NoopTelemetrySink`. The structured-logger hook (§5.2) is separate: logs are operator-facing text, telemetry is structured spans/events.
- `TuvrenTelemetrySink` is a synchronous, host-owned callback surface. The runtime isolates throwers but does not flush or dispose sinks; any buffering/export lifecycle contract belongs to the sink implementation or host wrapper rather than to `TuvrenInstance[Symbol.asyncDispose]()`.
- `@tuvren/telemetry-otel` exports `createOtelTelemetrySink(options): TuvrenTelemetrySink`, mapping records onto OpenTelemetry spans/events with the authored semconv attributes and emitting through the OpenTelemetry SDK. Exact `@opentelemetry/*` versions are pinned in the activation epic.
- No telemetry record may carry secret material (ADR-044); host-supplied attributes pass through a semconv allowlist, secret-like values on otherwise allowed keys are dropped or sanitized, and any `TelemetrySpan.error.message` is a sanitized runtime summary rather than a raw upstream error string.

### 4.19 Execution Bounds Contract

- **Style:** library configuration plus terminal-result semantics
- **Ownership:** `@tuvren/core/execution` owns the `ExecutionBounds` and `ExecutionBoundExceededDetails` types (§3.11); `@tuvren/core/errors` owns the `execution_bound_exceeded` code; `@tuvren/runtime` owns the guard.
- **Compatibility Strategy:** §2.1 execution bounds compatibility. Reuses the `failed` `ExecutionResult` discriminant from ADR-035; no new union variant.
- **Error model:** Reaching a hard-stop bound finalizes the turn as a `failed` `ExecutionResult` whose `error` is a `TuvrenRuntimeError` with code `execution_bound_exceeded` and `details: ExecutionBoundExceededDetails`. A fatal canonical `error` event carries the same code/details for live stream consumers, and the matching `turn.end` event marks the failed terminal state. The bound metadata remains on the `ExecutionResult`, the canonical `error` event details, and the bounded-execution telemetry event rather than on `turn.end`.

- Bounds are configured via `createTuvren({ bounds?: ExecutionBounds })` and `RuntimeCoreOptions.bounds`. Unset fields take the documented safe defaults (§3.11). Each configured field must be a finite positive integer; the runtime rejects `Infinity`, `NaN`, zero, and negative values during construction. `maxIterations` and `maxToolCalls` are checked at iteration and tool-batch boundaries, with `AgentConfig.maxIterations` clamped to `bounds.maxIterations`; `maxWallClockMs` wraps the whole turn with a deadline that propagates an abort signal through `TuvrenPrompt.signal` and `ToolExecutionContext.signal`, and late completions after abort are ignored; and `maxConcurrentToolCalls` throttles tool execution to the configured cap. A driver cannot raise or disable a framework bound.
- `maxConcurrentToolCalls` is a resource cap, not a terminal failure threshold: the framework queues or throttles work so a compliant turn stays within the configured parallelism instead of surfacing `execution_bound_exceeded` purely for requesting more parallel tools than the cap allows. When `AgentConfig.maxParallelToolCalls` or `defaultMaxParallelToolCalls` is present, the effective parallel-tool limit is the minimum of that value and `bounds.maxConcurrentToolCalls`; the framework bound is the non-bypassable ceiling.

### 4.20 Fault-Injection and Recovery Verification Seam (Test-Only)

- **Style:** testkit library API (no production surface)
- **Ownership:** `@tuvren/kernel-testkit` owns `createFaultInjectingBackend` and `FaultPlan` (§3.12).
- **Compatibility Strategy:** §2.1 recovery verification compatibility. Testkit-only; not part of any public-runtime contract.
- **Error model:** Injected checkpoint-commit faults surface as `TuvrenPersistenceError`, the same error family the runtime already raises on real persistence failure, so recovery code under test cannot tell an injected persistence fault from a real one. The seam does not claim a separate recovery-operation injection mode.

- `createFaultInjectingBackend(inner, plan)` wraps a real backend and interrupts `transact` at the `FaultPlan.point` relative to the durable commit, optionally racing a concurrent writer (§3.12).
- The seam is consumed only by the `kernel-crash-recovery` check set in `kernel-restart-recovery.json` and by recovery scenario tests; it must not be imported by `@tuvren/core`, `@tuvren/runtime`, any backend, the host-facing SDK, any driver, or the reference host.
- Recovery invariant asserted by the plan: a recovered branch head is always a committed TurnNode; no torn or partial TurnNode is observable; staged-but-uncommitted work is fully recovered or fully absent; the runtime resumes only unfinished work or fails the run cleanly with `TuvrenRecoveryError`; and two writers racing one branch head never corrupt lineage (one wins; the other observes a typed lineage conflict).

### 4.21 Capability Orchestration Contract

- **Style:** library API plus runtime resolution and policy semantics
- **Ownership:** `@tuvren/core/capabilities` owns the §3.13 types. `@tuvren/runtime` owns the Capability Registry, Binding & Endpoint Resolver, and Capability Policy Engine; the Tuvren-client endpoint runtime lands in Epic AZ. The Provider Gateway (`@tuvren/provider-api` + `@tuvren/provider-bridge-ai-sdk`) owns provider-native and provider-mediated representation; `@tuvren/mcp-client` is reframed as a binding mechanism.
- **Compatibility Strategy:** §2.1 capability-orchestration compatibility. Adding the `/capabilities` subpath and the capability types is additive and semver-minor; the existing `TuvrenToolDefinition` (`@tuvren/core/tools`) is unchanged and is the Tuvren-server binding. Adding the execution-class + `owner` attribution to canonical events and telemetry is additive (new optional dimension).
- **Error model:** Exposure denials remove a surface from the model-visible set (no error to the model) — the enforcement wiring that filters the tool-set before the model sees it lands in Epic BB; invocation-time enforcement is active as of Epic AW. Invocation denials and unavailable bindings surface as `tool.result` with `isError: true` carrying the appropriate existing error family — `TuvrenValidationError` for local input-contract violations (`tool_input_validation_failed`), `TuvrenProviderError` for provider/mediated/MCP-advertised failures (e.g. `mcp_tool_input_invalid`), and a new `capability_binding_unavailable` `TuvrenRuntimeError` when no admissible binding exists (for example a Tuvren-client endpoint is not attached). Provider-native invocation failures are recorded from provider-exposed results.

- The runtime resolves each model-visible tool call through: Capability Registry (which surfaces are eligible) → Capability Policy Engine (exposure-time; wiring into tool-set construction lands in Epic BB) → the model sees only exposed surfaces → on a tool call, Binding & Endpoint Resolver (resolve capability → execution class + endpoint) → Capability Policy Engine (invocation-time; active as of Epic AW) → dispatch to the execution-class endpoint. This preserves the conceptual invariant.
- Exposure-time policy inputs: provider, model, user/org permissions, data-residency, endpoint availability. Invocation-time policy inputs: approval requirements, credential boundary, user-presence, idempotency/retry, risk classification. Both are framework-owned decision points above driver discretion (consistent with the §4.19 bounds guard and the §5.6.3 approval/secret rules).
- Execution-class dispatch: `tuvren-server` → Tool Execution Gateway (full lifecycle; today's `execute` path); `provider-native` → Provider Gateway enables/configures the provider tool and records provider-exposed events/results only; `provider-mediated` → Provider Gateway configures the mediated relationship (e.g. provider-invoked remote MCP) and records what the provider/tool protocol exposes; `tuvren-client` → Client Endpoint Boundary leases an attached endpoint, dispatches an invocation envelope, and records the client-reported result (lands in Epic AZ).
- Observation honesty: the runtime emits a canonical invocation event tagged with the execution class and `owner` (`provider` | `tuvren`) plus a `CapabilityObservation`. It must not expose a cancel/retry/audit affordance for an invocation whose class does not grant it. Secret isolation (§5.6.3) applies to every class: no provider/MCP/client credential reaches durable state, events, telemetry, or transcripts.
- Back-compatibility: `defineTool(...)` / `TuvrenToolDefinition` continue to produce a Tuvren-server capability; existing hosts require no change. New execution classes are opt-in via capability/binding configuration.

