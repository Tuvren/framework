# Epic Y Single Semantic Conformance Engine Spike

Status: Accepted as the governing adjustment for final Epic Y closure.

## Problem

Epic Y correctly moved cross-implementation authority into authority packets,
generated artifacts, conformance plans, fixtures, guardrails, and measured
evidence. Review feedback exposed a remaining architectural risk: "one
runner per language" can quietly become "one semantic engine per language."

That would reintroduce the same class of oracle Epic Y exists to remove. A
Rust, Go, Python, or TypeScript runner could read the same plan data while
disagreeing about assertion operators, required evidence, adapter failures,
capability selection, or what counts as pass/fail. The source of truth would
then be split between language runners instead of staying in the shared
authority stack.

## Judgment

The final Epic Y target is:

```text
one semantic conformance engine
many language adapter hosts
one evidence format
one assertion engine
one conformance-plan language
```

Language-specific code remains necessary, but it belongs only at the adapter
host boundary. An adapter host starts or links the native implementation,
translates neutral operation requests into native calls, observes native
results/events/errors/state, and returns neutral observations. It must not
decide pass/fail, evaluate assertions, know check IDs, or emit check-scoped
evidence.

The shared semantic runner owns plan loading, scenario and fixture loading,
schema validation, assertion evaluation, required-evidence enforcement,
capability selection, adapter-error isolation, and compatibility evidence
emission.

## Target Shape

```text
tools/conformance/runner/
  run.ts
  plan-loader/
  scenario-loader/
  assertion-engine/
  adapter-client/
  evidence-writer/

boundaries/framework/implementations/typescript/conformance-adapter/
  adapter.json
  adapter-host.ts

boundaries/framework/implementations/rust/conformance-adapter/
  adapter.json
  src/main.rs
```

The first canonical semantic runner may be implemented in TypeScript/Bun
because the repository already has authority packet validation, plan
compilation, JSON Schema tooling, guardrails, compatibility reporting, and
verification orchestration there. That is an implementation choice for the
tool, not a claim that TypeScript owns framework semantics. The structural
rule is that the runner may consume only authority packets, generated
artifacts, plans, scenarios, fixtures, generic assertion operators, adapter
manifests, adapter observations, and evidence writers. It may not import
implementation packages such as runtime-core, react-driver, stream adapters,
provider bridges, framework testkits, or Rust implementation crates.

The runner target is not framework-only. It must drive the current Kraken
Engine conformance lanes: kernel, framework/runtime, ReAct driver, providers,
and future promoted surfaces through the same assertion/evidence engine.

## Adapter Protocol Direction

The normative adapter boundary should become a process-level JSON-RPC 2.0
protocol over stdio. JSON-RPC 2.0 requires request and response objects to
carry `jsonrpc: "2.0"`, correlates responses by `id`, and requires success
responses to carry `result` without `error` while error responses carry
`error` without `result`. Tuvren's adapter protocol will layer its neutral
operation vocabulary and observation envelope on top of that transport.

Example adapter manifest:

```json
{
  "adapterId": "rust-framework",
  "protocol": "tuvren.conformance-adapter/1.0.0",
  "command": ["cargo", "run", "-p", "tuvren-framework-rust-conformance-adapter"],
  "capabilities": [
    "framework.runtime-api",
    "framework.driver-api",
    "framework.event-stream"
  ]
}
```

Core methods:

```text
initialize
createInstance, when a surface needs stateful execution
dispatch
events
inspectState
destroyInstance, when createInstance was used
shutdown
```

Adapter success returns neutral observations:

```json
{
  "kind": "result",
  "value": {
    "result": {},
    "events": [],
    "state": {},
    "evidence": {},
    "diagnostics": {}
  }
}
```

Adapter or protocol failure returns an adapter error:

```json
{
  "kind": "error",
  "error": {
    "code": "adapter_operation_failed",
    "message": "operation failed before implementation evidence was produced",
    "details": {}
  }
}
```

Adapter errors are not implementation results and must not populate
`$.result.error`. This prevents an unimplemented adapter from accidentally
satisfying an implementation error-envelope assertion.

## Decisions

- The final conformance engine is shared under `tools/conformance/runner/`;
  implementation language trees expose adapter hosts only.
- Current TypeScript and Rust framework conformance entry points are
  transitional and must not be described as the final architecture.
- Adapters must not receive `checkId`, must not call `emitEvidence(checkId, ...)`,
  and must not decide pass/fail.
- `applicability.capabilities` is executable. The runner selects checks from
  adapter manifest or initialization capabilities, not from implementation IDs,
  language names, runner names, or bespoke skip matrices.
- Required evidence paths are part of the assertion contract. Missing required
  evidence is a check failure even if all assertion operators pass.
- While duplicated runner mechanics still exist, the repo needs
  assertion-engine meta-conformance so any temporary runner semantics can be
  compared against a fixed corpus.
- Fixture replay can validate authority fixtures, but it cannot count as
  implementation conformance unless native implementation logic produced the
  observation being asserted.
- Lifecycle and checkpoint-heavy semantics need multi-step trace plans, not
  only single-operation checks.

## Migration Plan

1. Stabilize the current PR posture: say authority-packet closure is complete
   enough to use, but final language-agnostic conformance remains active until
   a shared semantic runner drives adapter hosts.
2. Extract plan loading, scenario loading, assertion evaluation, required
   evidence enforcement, capability selection, adapter-error isolation, and
   evidence writing into `tools/conformance/runner/`.
3. Define a machine-validated adapter manifest and JSON-RPC stdio adapter
   protocol. Remove check-scoped evidence emission from adapter contracts.
4. Convert the TypeScript framework conformance package into a framework
   adapter host driven by the shared runner.
5. Convert the Rust framework conformance package into a Rust adapter host
   stub driven by the shared runner. Red evidence remains red until Rust
   implementation logic exists.
6. Add assertion-engine meta-conformance for every generic operator and for
   adapter-error isolation.
7. Extend conformance plans with multi-step traces so pause/resume,
   checkpoint, recovery, branching, and lifecycle semantics can be proven by
   implementation behavior rather than by single-operation shortcuts.
8. Refresh compatibility evidence and record the final Epic Y closure
   inventory only after normal verification commands fail on red structured
   evidence and pass on truly conforming implementation behavior.

## Merge Posture

Do not block solely because the current PR does not yet have one universal
runner. Do block any claim that "each language owns its own semantic runner"
is the final architecture.

The acceptable transition claim is:

```text
PR33 closes the current machine-authority packet leaks.
Per-language conformance entry points are transitional.
The final Epic Y closure is one semantic runner over many adapter hosts.
```
