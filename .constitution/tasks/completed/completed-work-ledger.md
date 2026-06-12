# Completed Work Ledger (pre-migration closed epics)

Closed epics AW, AX, AY, AZ, BA, BB. Detail lives in git history and `.constitution/archived/`; these do not contribute to active story points. Migrated verbatim from `Tasks.md §4`.

### Completed Work Ledger (Epics AX–BB)

Completed ticket detail is removed from the active execution plan and retained through git history plus archived support artifacts. This ledger is the live audit summary for the five most recently closed epics; older closure records live in git history and `.constitution/archived/`.

| Epic | Points | Closed Outcome | Evidence Anchor |
| --- | ---: | --- | --- |
| AX | 28 | Delivered the Tuvren-Server Execution Class: input/output validation with typed error codes (`tool_input_validation_failed`, `tool_result_validation_failed`, `TuvrenToolDefinition.outputSchema`), idempotent retry (`idempotent`, `maxRetries`, framework-owned retry loop in `executeSingleTool`, cooperative cancellation, late-completion ignoring), tenant isolation + rate-limiting (`AgentConfig.serverExecution`, `ServerRateLimiter`, `TOOL_INVOCATION_RATE_LIMITED`, per-turn per-instance scoping), server-side MCP binding classification confirmed (`mcp-server` endpoint kind), server sandbox endpoint (`TuvrenSandboxExecutor`, `metadata.sandbox.endpointId`, `tuvren-sandbox` endpoint kind, `AgentConfig.sandboxExecutors`), full-lifecycle `ToolAuditEvent` (`tool.audit`) at five lifecycle points with secret isolation, and `tuvren-server-execution-class` conformance check set (19 checks: AX001–AX006 including cancellation/late-completion, tenant isolation, and output-validated audit). | `tuvren-server-execution-class` conformance plan (19/19 pass); `boundaries/shared/contracts/core/spec/authority-packet.json` |
| AY | 39 | Delivered Provider-Native & Provider-Mediated Execution Classes through the AI SDK bridge: `ProviderNativeToolDeclaration`/`ProviderMediatedToolConfig` in `TuvrenPrompt`/`AgentConfig`; bridge `providerToolClassLookup` accepts declared provider tool results; pre-staged provider tool messages bypass the Tool Execution Gateway; `emitProviderToolAttributionEvents` emits `tool.start`+`tool.result` with `owner:"provider"` and per-class observation limits (canAudit/canCancel/canRetry/canResume: false, canPersistResult: true); `assertDriverMessages` guard extended for pre-staged provider messages; `isProviderOnlyResponseEventSet` guard handles pure provider-stream responses; concrete generate and stream proofs for Anthropic code_execution and OpenAI MCP patterns; `provider-native-execution-class` (10 checks) and `provider-mediated-execution-class` (10 checks) in the `tuvren.providers.provider-api` authority packet; 52/52 provider conformance checks pass. Known gap: AY005 multi-turn providerContinuity extraction round-trip is structurally wired but not exercised by a multi-turn test. | `provider-native-execution-class` and `provider-mediated-execution-class` conformance plans (20 new checks, 52/52 total); `boundaries/providers/contracts/provider-api/spec/authority-packet.json`; `.constitution/reports/ay001-provider-surface-matrix.md` |
| AZ | 37 | Delivered the Tuvren-Client Execution Class (runtime side only): `AttachedClientEndpoint`, `ClientEndpointCapabilityAdvertisement`, `ClientInvocationEnvelope`, `ClientReportedResult`, `ClientEndpointBoundary` (with `detach()`), `ClientDispatchResult` shapes in `@tuvren/core/capabilities`; `AgentConfig.clientEndpoints` and `AgentConfig.clientEndpointBoundary` wired; synthetic `TuvrenToolDefinition` entries from advertised capabilities route dispatch through the boundary with leaseToken staleness detection; `isClientEndpointTool` guard suppresses `tool.audit` events and server-side rate-limiting (canAudit: false); `observationForClass("tuvren-client")` explicit; client-side MCP classified as `tuvren-client / mcp-server` endpoint kind; `PauseContext` and `LoopState` carry the boundary through lifecycle; `tuvren-client-execution-class` conformance check set (13 checks) registered in authority packet; client-endpoint integration contract documented. 394 runtime tests + 379/379 framework conformance checks pass; kernel verify:kernel:fresh passes. Concrete client endpoints remain host-developer deliverables. | `tuvren-client-execution-class` conformance plan (13/13 pass); `boundaries/shared/contracts/core/spec/authority-packet.json`; `boundaries/framework/contracts/client-endpoint-integration.md` |
| BA | 26 | Delivered Invocation Lifecycle & Observation Model: `InvocationLifecycleState` union type added to `@tuvren/core/capabilities` formalising the uniform cross-class lifecycle (resolved → policy-admitted → dispatched → completed/failed/ignored); provider-native/mediated `tool.start`/`tool.result` attribution events routed through `publishRuntimeEvent` so telemetry observes them (BA002 gap closed); `null` used as the JSON-serializable "not observed" sentinel for provider tool `tool.start` inputs; cross-class resume/recovery semantics proven: tuvren-server fails clean per durability, provider classes resolve from observed driver output, tuvren-client stale/unavailable paths surface CAPABILITY_RESULT_STALE/CAPABILITY_BINDING_UNAVAILABLE, turn abort terminates as `execution_cancelled`; lifecycle telemetry depth confirmed: `tool_call` spans keyed to runtime lineage + execution class for all four classes using existing semconv (no semconv extension needed); `invocation-lifecycle-observation` conformance check set (19 checks covering BA001–BA003) registered as an executable verification path. 424 runtime tests pass; 399/399 framework conformance checks pass; `bun run verify` exits 0. | `invocation-lifecycle-observation` conformance plan (19/19 pass); `boundaries/shared/contracts/core/spec/authority-packet.json` |
| BB | 26 | Delivered Exposure & Invocation Policy Model: `PolicyCapabilityMetadata` type added to `@tuvren/core/capabilities` (riskClass, requiredResidency, requiresUserPresence, requiredCredentialScopes, nonRetryable); `CapabilityPolicyContext` extended with all §4.21 dimensions; `TuvrenToolDefinition` gains five optional policy fields; `AgentConfig.policyContextInputs` added; full five-dimension policy engine (BB001 residency, BB002 risk/approval, BB003 active-endpoint/user-presence, BB004 credential-boundary/nonRetryable, BB005 composition/precedence); exposure-time filtering wired in `createDriverExecutionContext`; invocation-time context populated from real config; resume-path invocation check in `resolveResumeDecision` (tool-resume `createToolBatchEnvironment` fixed to carry policy engine); `requiresApproval` from policy engine bridges to pending-approval flow; `nonRetryable` overrides `idempotent` in retry budget; `capability-policy` conformance check set (26 checks, BB001–BB005 at both decision points + composition + control path) registered in `tuvren.shared.core` authority packet; compatibility evidence refreshed. 472 runtime tests pass; 425/425 framework conformance checks pass. | `capability-policy` conformance plan (26/26 pass); `boundaries/shared/contracts/core/spec/authority-packet.json`; `reports/compatibility/evidence/` |

### Epic AW — Capability Orchestration Foundation (KRT)

**Status:** **CLOSED.** See Completed Work Ledger. Ticket bodies retained in git history.

### Epic AX — Tuvren-Server Execution Class (KRT)

**Status:** **CLOSED.** See Completed Work Ledger. Ticket bodies retained in git history.

### Epic AY — Provider-Native & Provider-Mediated Execution Classes (KRT)

**Status:** **CLOSED.** See Completed Work Ledger. Ticket bodies retained in git history.

### Epic AZ — Tuvren-Client Execution Class (KRT)

**Status:** **CLOSED.** See Completed Work Ledger. Ticket bodies retained in git history.


### Epic BA — Invocation Lifecycle & Observation Model (KRT)

**Status:** **CLOSED.** See Completed Work Ledger. Ticket bodies retained in git history.

### Epic BB — Exposure & Invocation Policy Model (KRT)

**Status:** **CLOSED.** See Completed Work Ledger. Ticket bodies retained in git history.

