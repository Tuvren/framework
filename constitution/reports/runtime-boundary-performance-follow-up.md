# Runtime Boundary Performance Follow-Up

## Purpose

Capture the conclusions from the recent codebase assessment discussion so they can guide a dedicated profiling and optimization session later, without prematurely widening scope or weakening documented runtime boundaries.

## Summary Judgment

The reviewed feedback is directionally useful, but it should not be accepted literally.

The strongest signal is that the framework currently pays a real defensive-copying and snapshotting cost across several in-process boundaries. This is visible in driver execution context creation, stream fanout, extension hook execution, tool execution contexts, and manifest handling.

At the same time, some of the proposed fixes would move or weaken checks that are currently load-bearing according to the authoritative framework specification and the TechSpec. The right lesson is not "remove the boundary protections", but "profile and optimize those protections carefully".

## Conclusions To Keep

### 1. Defensive copying is likely a real performance tax

The runtime uses repeated `structuredClone`, frozen snapshots, and clone-preserving helpers in multiple hot or semi-hot paths. This makes the general assessment credible: safety is currently being purchased with memory allocation and copying overhead.

### 2. Stream-path optimization is worth investigating

The stream critique identified a real area of interest, but the proposed remedy was too aggressive.

We should not remove shared-core validation from the driver stream boundary. The framework spec explicitly requires runtime-core to reject invalid driver-owned stream events and to reconcile assistant stream events against the durable assistant message.

The useful takeaway is narrower:

- keep boundary validation in shared core
- profile the cost of cloning at `runtime.emit(...)`
- profile additional cloning in event fanout to subscribers
- optimize clone strategy only if the boundary guarantees remain intact

### 3. Snapshot-heavy extension and tool contexts deserve scrutiny

The current runtime hands cloned or frozen snapshots into extension and tool-facing contexts in several places. This may account for as much or more overhead than the driver emit path itself.

This should be measured explicitly rather than assumed.

### 4. The structural-sharing idea is mostly valid, but should be applied precisely

The high-level observation is good: the system should rely on structural sharing where possible instead of repeatedly deep-cloning large immutable shapes.

However, the repo already commits to structural sharing at the kernel level, and ordered-path chunking already exists internally for long ordered paths. The likely opportunity is therefore not changing kernel semantics, but reducing repeated cloning of already-snapshotted framework data in memory.

### 5. The CBOR recommendation is plausible, but not yet justified

The kernel identity path does recursively canonicalize records and sort object keys before deterministic CBOR encoding, so there is real CPU work there.

Still, this area sits on a protocol and compatibility boundary:

- deterministic CBOR is part of durable identity semantics
- changes here are semver-major in effect
- a static/precompiled serializer approach needs a dedicated spike before it can be treated as actionable

For now, this remains a hypothesis, not an accepted optimization plan.

## Conclusions To Reject Or Reframe

### 1. Do not move stream validation out to a protocol adapter layer

That would conflict with the current framework specification, which makes shared core responsible for validating the driver stream contract.

### 2. Do not assume the hottest cost is only `runtime.emit(...)`

The repo shows a broader pattern of cloning and snapshot creation across runtime-core, extension runtime, tool execution helpers, orchestration runtime, and status/event fanout. Any future optimization session should treat this as a distributed cost center, not a single-function problem.

### 3. Do not start with serializer rewrites

Because kernel identity rules are compatibility-critical, serializer specialization should only be considered after measurement proves it is a material bottleneck.

## Recommended Follow-Up Session

The dedicated session should be profiling-first.

### Session goals

1. Measure allocation and CPU cost around driver event emission and subscriber fanout.
2. Measure allocation and CPU cost around extension and tool context snapshot creation.
3. Measure kernel identity encoding overhead separately from framework runtime overhead.
4. Identify which costs are hot-path, which are occasional boundary costs, and which are acceptable by design.

### Suggested profiling targets

- `runtime.emit(...)` driver boundary path
- event fanout cloning per subscriber
- extension hook context construction
- tool execution and around-tool context construction
- manifest cloning and update flows
- deterministic kernel record encoding and hash generation

### Suggested benchmark posture

Use a synthetic stress harness rather than assuming current ReAct-driver depth is already representative of the final loop design.

Good candidates:

- high-volume assistant stream event sequences
- repeated extension-hook execution over growing manifests
- repeated tool-call iterations with cloned tool metadata and shared exports
- isolated kernel identity encoding loops over canonical entity shapes

## Decision Record

For the next dedicated session, we should treat the assessment as:

- accepted in spirit on clone/snapshot overhead
- rejected in its suggestion to weaken shared-core stream validation
- deferred on deterministic-CBOR serializer specialization until profiling data exists

## Scope Reminder

This note is intentionally not a spike, implementation plan, or ADR. It exists to preserve the judgment so a later performance-focused session can start from aligned premises instead of re-litigating the original assessment.
