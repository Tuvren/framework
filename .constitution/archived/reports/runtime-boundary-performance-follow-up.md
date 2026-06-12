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

## Deferred Spike Ticket

This work should not enter the active critical path before Epic I is complete.

The right posture is:

- keep Epic I focused on the first concrete ReAct Driver foundation slice
- preserve the current shared-core boundary guarantees
- schedule this as a dedicated post-Epic-I profiling and optimization spike

### Proposed ticket

**KRT-P001 Runtime Boundary Performance Profiling Spike**

- **Type:** Spike
- **Timing:** Deferred until Epic I is complete
- **Goal:** Measure the real CPU and allocation cost of clone-heavy framework boundary protections before making any optimization changes
- **Non-goals:**
  - weakening shared-core stream validation
  - changing durable kernel identity semantics
  - broad framework refactors without measurement

### Spike acceptance criteria

1. The repo contains a reproducible benchmark harness or targeted perf test entrypoints for the profiling targets listed below.
2. The spike produces a short written findings report with measured timings and allocation-oriented observations for each benchmark family.
3. The findings separate:
   - hot-path runtime costs
   - occasional boundary costs
   - compatibility-sensitive kernel identity costs
4. The findings end with a ranked optimization shortlist that preserves current spec-aligned runtime guarantees.

## Benchmark Plan

The dedicated session should be profiling-first.

### Measurement goals

1. Measure allocation and CPU cost around driver event emission and subscriber fanout.
2. Measure allocation and CPU cost around extension and tool context snapshot creation.
3. Measure manifest update and rebuild costs separately from stream-path costs.
4. Measure kernel identity encoding overhead separately from framework runtime overhead.
5. Distinguish between costs that are structurally required by the current contracts and costs that are likely implementation overhead.

### Benchmark families

#### 1. Driver stream boundary bench

Measure:

- cloning at `runtime.emit(...)`
- shared-core event validation
- additional cloning in subscriber fanout

Scenarios:

- single subscriber, high-volume assistant text stream
- two and four subscribers, same event payload volume
- structured output events carrying nested data payloads
- tool-call stream events with large argument payloads

Outputs:

- wall-clock time per emitted event sequence
- relative cost as subscriber count increases
- notes on payload-size sensitivity

#### 2. Extension hook context bench

Measure:

- hook context construction cost for `beforeTurn`, `beforeIteration`, `afterIteration`, and `afterTurn`
- cloning cost for `manifest`, `messages`, `response`, `resolution`, `toolResults`, extension state, and shared exports

Scenarios:

- no extensions
- one extension with small state
- multiple extensions with growing manifest extension state
- long message history with repeated hook execution

Outputs:

- per-hook invocation cost
- scaling behavior by message count, extension count, and extension-state size

#### 3. Tool execution context bench

Measure:

- `ToolExecutionContext` construction cost
- `AroundToolContext` construction cost
- cloning cost for tool metadata, tool input, manifest, shared exports, and per-extension state

Scenarios:

- repeated single-tool execution
- parallel tool batches
- around-tool chains with multiple extensions
- large tool metadata / input payloads

Outputs:

- per-tool and per-batch cost
- sensitivity to around-tool depth and metadata size

#### 4. Manifest update flow bench

Measure:

- `updateContextManifest(...)` cost during ordinary iteration checkpoints
- full manifest rebuild cost during context engineering and handoff flows
- extension-state merge cost inside manifest updates

Scenarios:

- append-only message growth
- repeated tool-result incorporation
- large extension namespace maps with small incremental updates
- full context rewrite with rebuilt message history

Outputs:

- per-update and per-rebuild cost
- evidence for whether manifest extension cloning is a primary cost center

#### 5. Kernel identity bench

Measure:

- deterministic record canonicalization
- key sorting during deterministic CBOR encoding
- hash generation over representative kernel records

Scenarios:

- canonical entity-shape records from the TechSpec
- growing nested records with many object keys
- repeated hashing of stable shapes in tight loops

Outputs:

- isolated encoding and hashing cost
- recommendation on whether this area is material enough to justify a later serializer spike

### Suggested harness posture

Use a synthetic stress harness rather than assuming current ReAct-driver depth is already representative of the final loop design.

The harness should:

- run in-process against the current TypeScript runtime implementation
- favor narrow, isolated benchmarks over full end-to-end mixed workloads
- vary payload size, history size, extension count, and subscriber count independently
- report repeated-run timings so relative trends are visible instead of relying on single samples

### Suggested benchmark inputs

Good candidates:

- high-volume assistant stream event sequences
- repeated extension-hook execution over growing manifests
- repeated tool-call iterations with cloned tool metadata and shared exports
- isolated manifest update loops over growing message histories
- isolated kernel identity encoding loops over canonical entity shapes

## Expected Deliverables

The spike should produce:

1. A benchmark harness or perf test entrypoints committed in-repo.
2. A concise findings note summarizing measured costs, likely hot paths, and important non-hot-path but high-allocation behaviors.
3. A ranked optimization backlog divided into:
   - safe implementation-level optimizations
   - optimizations requiring contract review
   - deferred compatibility-sensitive ideas

## Measured Findings

Measured on 2026-04-24 after committing the benchmark harness, stashing the implementation changes, running the baseline, restoring the implementation changes, and rerunning the same benchmark commands.

The deltas below use best per-iteration timings from the repeated-run benchmark output. Lower is better.

| Benchmark                                                       |     Before |      After |    Delta |
| --------------------------------------------------------------- | ---------: | ---------: | -------: |
| Stream boundary clone and validation                            |  `66.01us` |  `67.67us` |  `+2.5%` |
| Event fanout to one subscriber                                  |  `28.32us` |  `28.02us` |  `-1.1%` |
| Event fanout to four subscribers                                | `111.50us` | `112.59us` |  `+1.0%` |
| Extension beforeIteration context snapshots                     |   `1.84ms` |   `1.83ms` |  `-0.6%` |
| Extension afterIteration context snapshots                      |   `1.86ms` |   `1.85ms` |  `-0.6%` |
| Tool execution and around-tool context snapshots                | `240.20us` | `236.46us` |  `-1.6%` |
| Manifest append-only incremental updates                        | `347.46us` | `180.18us` | `-48.1%` |
| Manifest extension state merge updates                          | `371.47us` | `372.83us` |  `+0.4%` |
| Driver immutable snapshot creation                              | `459.99us` | `461.67us` |  `+0.4%` |
| React stream publication with shared-core clone simulation      | `549.83us` | `442.35us` | `-19.5%` |
| React generate buffered flush with shared-core clone simulation | `161.25us` | `136.04us` | `-15.6%` |
| Deterministic CBOR encode canonical nested record               |   `4.16ms` |   `4.15ms` |  `-0.3%` |
| Deterministic CBOR encode and SHA-256 hash                      |   `4.40ms` |   `4.40ms` |  `-0.1%` |

The event fanout rows above came from the initial benchmark harness used for the measured before/after run. A later review pass replaced that legacy `EventFanout` utility coverage with benchmarks for the current single-consumer execution-handle queue and subtree-forwarding queue paths, so future benchmark runs intentionally use updated names for that stream-lifecycle area.

### Findings Summary

The meaningful wins were targeted:

- Manifest append-only updates improved by roughly `48%`, confirming that avoiding unnecessary extension-state cloning is valuable for ordinary turn growth.
- React driver stream publication and buffered flush improved by roughly `15-20%`, confirming that removing duplicate in-process cloning before the shared-core stream boundary matters for streaming-heavy flows.
- Kernel identity timings were effectively unchanged, which supports the decision to defer deterministic-CBOR serializer specialization.
- Extension and tool snapshot paths were roughly flat. They remain measurable costs, but this run did not justify widening the implementation scope beyond the safe optimizations already made.

## Implementation Guidance For The Future Spike

Start with measurement only.

Only after profiling data exists should the follow-up implementation session consider changes such as:

- reducing redundant manifest extension cloning while preserving isolation guarantees
- caching read-only driver tool snapshots when registry contents are unchanged
- caching or narrowing shared-export snapshots
- reducing duplicate status snapshotting in runtime and orchestration layers

Do not begin with:

- moving stream validation out of shared core
- relaxing event payload isolation between subscribers
- changing deterministic CBOR or kernel identity semantics

## Decision Record

For the deferred post-Epic-I spike, we should treat the assessment as:

- accepted in spirit on clone/snapshot overhead
- rejected in its suggestion to weaken shared-core stream validation
- deferred on deterministic-CBOR serializer specialization until profiling data exists

## Scope Reminder

This note now serves as a deferred spike definition and benchmark brief.

It still does not authorize immediate optimization work inside Epic I, and it should not be treated as approval to widen the current ReAct Driver foundation scope before that epic is complete.
