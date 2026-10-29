---
owner: stage-3
date: "2026-10-29"
---
# Downstream Blockers and Owner Rulings

This is an investigation and ruling record for ADR-0082 and ADR-0083. The brief is a task brief from the downstream product's planning session, written by its owner. This record is not authority; authority packets and conformance plans under `spec/` remain the cross-implementation oracle. The investigation preceded these rulings, so its proposed sequencing and initial portability design are historical, not decisions.

## Fact check of the brief's "State on 2026-10-29"

| Brief claim | Verdict | Evidence |
| :--- | :--- | :--- |
| Every `@tuvren/*` latest is 0.3.0, published 2026-10-18 | True | `npm view` / `npm search`: 19 public packages, all 0.3.0, times 2026-10-18T03:11–03:15Z |
| No backend testkit published; kernel, provider, and framework testkits and the certification packages are `private: true` | True | `@tuvren/kernel-testkit`, `provider-testkit`, `framework-testkit` return E404; manifests are `private: true` |
| #154 closed COMPLETED on 2026-10-14 with no linked PR, and nothing public shipped | True | `closedAt 2026-10-14T17:56:40Z`, `stateReason COMPLETED`, `closedByPullRequestsReferences: []`, no comments |
| The research doc says publishing waits on observation-only certification | True | `.constitution/research/2026-10-22-observation-only-certification-designs.md:11` |
| The wave plan (DF, DG, DH, DI → DJ → CB → CC…CQ) has no epic that publishes it | True | `critical-path.md`. Only EPIC-CJ mentions `@tuvren/kernel-testkit`, to add Bazel targets |
| #155 shipped in 0.3.0 through EPIC-CS; `TuvrenRuntime.readBranchMessages` is the readback path | True | PR #171 merged 2026-10-18T01:13:58Z; all 20 `KRT-CS` commits are ancestors of `v0.3.0`; `readBranchMessages` is in the published `@tuvren/core` `runtime-contract-shapes.d.ts` |
| #156 shipped in 0.3.0 through EPIC-CR: "merge `cb79e1c`" is an ancestor of `v0.3.0` | True, with a wording slip | `cb79e1c` is an ancestor, but it is a single-parent commit ("fix(constitution): declare CR003 live-probe result"), not a merge. The repository rebase-merges, so EPIC-CR has no merge commit. |
| Runtime changelog entry is `ed385c0`; published dist contains `runtime_recovery_interrupted_iteration_unreadable`; issue still open | True | `typescript/runtime/CHANGELOG.md:12`; 2 hits in `@tuvren/runtime@0.3.0/dist/index.js`; #156 `OPEN` |
| Unreleased changesets: kernel-runtime minor (canonical codes) and the memory backend's removed `midCommit` | True, but incomplete | Also present: a `@tuvren/kernel-testkit` minor (barrier control; a private package), a kernel-protocol patch, and lint-prep patches. With the fixed group, the next release is **0.4.0**. |
| The EPIC-DF worktree holds unmerged closeout commits | True | The branch is 22 commits ahead of master, HEAD `fc51fe6` (closeout) |
| "EPIC-DF removed the commit hook" | True **only on the unmerged branch** | KRT-DF003 removes `FAULT_INJECTION_CONTROL` from SQLite and PostgreSQL; the testkit seam is in `typescript/kernel/testkit/src/lib/commit-fault-seam.ts` and `typescript/kernel/testkit/src/lib/durable-fault-control.ts` (`ef893e1` at the time of writing). On master both backends still carry it, and `docs/guides/add-a-kernel-backend.md` §3 still tells backend authors to implement it. |

The investigation also turned up facts the brief doesn't mention:

- **Two evidence systems exist, not one.** (a) The `register{Conformance,Invariant,Recovery}Suite` suites in `@tuvren/kernel-testkit` are self-asserting (`node:assert/strict`), work at the `RuntimeBackend` level, and only the memory, SQLite, and PostgreSQL package tests use them. (b) Certification under ADR-0075 to ADR-0081 uses the shared harness (`tools/conformance/harness`) and kernel plans, catalog, profiles, and negative controls, driving a stdio JSON-RPC adapter (`typescript/kernel/conformance-adapter`, `--backend` flag). Only (b) is certification under the ADRs. Issue #154 and CF Bot's CFB-F002 ask to publish (a).
- **The harness is less portable than the testkit.** It uses `node:fs`, `node:path`, `node:child_process` `spawn`, `node:readline`, `node:os`, and `node:crypto` `createHash`. It runs `ajv.compile` at runtime (`assertion-engine/schema.ts`, `observation-encoding.ts`, `run-plans.ts`) and resolves files relative to `REPO_ROOT` (`run.ts:181`). The adapter imports `../../../../tools/conformance/adapter-protocol` through relative repository paths.
- **Tuvren's own production packages set the portability floor.** `@tuvren/kernel-runtime` imports `node:crypto` (`runtime-kernel.ts:17`). `@tuvren/backend-memory` uses `node:async_hooks` `AsyncLocalStorage` for nested-transaction detection (`memory-backend.ts:17,995`). `@tuvren/backend-shared` uses `node:process` `hrtime`, and `@tuvren/runtime` uses `node:crypto` `createHash` and `node:util` `isDeepStrictEqual`. A testkit cannot be more portable than the kernel it drives.
- On master, `spec/conformance/kernel/profiles.json` has only `kernel.memory`. `kernel.persistent-reopen`, `kernel.process-crash`, and `kernel.shared-backend` exist only on the DF branch.
- `RuntimeBackend` is public, re-exported from `@tuvren/sdk` (`typescript/sdk/src/index.ts:166`), so it really is a host-facing SPI that needs a public proof path.

## Investigation findings

- A public backend author has no portable, published certification path. The private self-asserting suites and the observation-only certification harness are separate evidence systems; only the latter is certification. The proposed portable runner shares authority, verdicts, plans, controls, and evidence with the CLI, while a host supplies its substrate and optional process boundary.
- The #156 recovery checks show that call identities survive stale-run recovery, but do not force process death. Dispatch is at least once across crashes, so host tools with external effects must deduplicate on the stable `context.idempotencyKey`. The investigation identified a missing host guide and `nonRetryable` documentation.
- Tool-admission failures can mask the first fatal error as a backend head mismatch and leave the branch unusable. Ajv compiles at runtime and fails when code generation is forbidden; the SDK plain JSON Schema helper path also accepts input unchecked. See the reproduction and causal chain below.
- On the unmerged durable-lifecycle branch, KRT-DF003 removes backend commit hooks and the testkit transaction seam wraps `RuntimeBackend.transact` (`typescript/kernel/testkit/src/lib/commit-fault-seam.ts` and `typescript/kernel/testkit/src/lib/durable-fault-control.ts`; `ef893e1` at the time of writing); master still has SQLite and PostgreSQL hooks. The branch also carries lifecycle profiles absent from master.

### Reproduction (published 0.3.0, Node v24 `--disallow-code-generation-from-strings`)

The session script used `createTuvren`, `createMemoryBackend()`, `createReActRunner({ providerCallMode: "generate" })`, and a scripted provider that makes one tool call to a plain-JSON-Schema tool. The commands and observed output are recorded from the session run; the script is not retained. The epic that fixes the bug encodes the reproduction as engine conformance checks.

- **Failing run:** `status: "failed"`, and `awaitResult()` reports `TuvrenRuntimeError` `memory_backend_active_run_turn_head_mismatch`. The event stream does carry the real cause: a fatal `error` event "Code generation from strings disallowed for this context", followed by the non-fatal head-mismatch error. There is no `tool.start` and no `turn.end`.
- **Controls:** without the flag, valid input runs the tool and invalid input yields `tool_input_validation_failed`. With the flag and a `CustomSchema`, both cases behave correctly.
- **The branch is left broken:** the next turn on the same branch fails with `kernel_runtime_turn_parent_start_mismatch`.
- **It is general:** an unresolvable `$ref` (Ajv `MissingRefError`) or a throwing `approval()` predicate gives the same masked result and the same broken branch, without the flag.
- **Master behaves identically.** The path was only refactored after `v0.3.0`; master source run through Bun reproduces it.

### Causal chain (master)

1. `ajv.compile` throws (`typescript/runtime/src/lib/tool-execution-validation.ts:50`, called from `:164`). Nothing catches it until `runtime-core-runner.ts:395`, which calls `failTrackedRunWithoutBranchAdvance`.
2. **Defect A:** `failTrackedRunWithoutBranchAdvance` (`runtime-core-turn-progress.ts:206-219`) calls `run.complete(failed)`. In the TypeScript kernel, that reactively checkpoints the staged assistant tool-call batch and moves both the branch head and the turn head (`runtime-kernel-lineage.ts:990,995`). Kernel specification sections 5.5 and 5.6 name only the branch head, while section 5.3 assigns turn-head moves to `turn.updateHead`; the implementing spike settles whether the checkpoint turn-head move is specified behavior or a kernel finding. The function then rewinds **only the branch head** (`:218`).
3. Finalization opens a run at the branch head (`runtime-core-status.ts:178`). The memory backend's lineage invariant rejects it (`memory-backend-lineage.ts:442-466`). SQLite and PostgreSQL carry the same check.
4. **Defect B:** `publishProjectedError` (`runtime-core-events.ts:345-353`) overwrites the remembered error for fatal and non-fatal errors alike. With no `turn.end`, `settleResult` (`runtime-execution-handle.ts:338`) reports the *last* error, which is the backend's, instead of the root cause.

### Related findings

- `defineTool({ inputSchema: <plain JSON Schema> })` and `jsonSchema(schema)` without `validate` build a `validate()` that accepts any input (`typescript/sdk/src/lib/schema-authoring.ts:242-256,389-392`). On **every** runtime, input validation is silently skipped on that authoring path, while the native path validates with Ajv.
- A plain JSON `outputSchema` under a no-codegen runtime becomes an `isError` result carrying the raw `EvalError`, and only after the tool already ran.
- When structured-output compilation fails, the result drops its `details`.
- Ajv 8.18.0 has no interpreter mode: every compile ends in `new Function` (`dist/compile/index.js:89`). Standalone precompilation works only for schemas known at build time. Host tool schemas, especially MCP tool schemas, which arrive at runtime, can't be precompiled.

## Reproduction commands and observed output

The 392-line `repro.mjs` composed `createTuvren`, the memory backend, a ReAct runner in generate mode, a scripted provider, and a single plain-JSON-Schema tool. It could trace kernel calls, run a second turn, switch to host validation, and select missing-reference and throwing-approval cases. The following commands and observed output are recorded from the session run in a scratch directory containing the published 0.3.0 packages; the original command history was not included with the output. The script is not retained, and the epic that fixes the bug encodes the reproduction as engine conformance checks.

```sh
TRACE_KERNEL=1 node --disallow-code-generation-from-strings repro.mjs plain valid
node repro.mjs plain valid
node repro.mjs plain invalid
node --disallow-code-generation-from-strings repro.mjs custom valid
node --disallow-code-generation-from-strings repro.mjs custom invalid
SECOND_TURN=1 node --disallow-code-generation-from-strings repro.mjs plain valid
node repro.mjs plain-badref valid
node repro.mjs custom-approval-throws valid
IMPL=master-src bun repro.mjs plain-badref valid
```

The controls and second-turn results are described in the reproduction above. The recorded trace for the first command follows; generated identifiers are run-specific.

```text
{"codegenProbe":"forbidden (EvalError: Code generation from strings disallowed for this context)","inputKind":"valid","mode":"plain","node":"v24.21.0"}
Error compiling schema, function code: const schema2 = scope.schema[2];const schema1 = scope.schema[1];return function validate1(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){let vErrors = null;let errors = 0;if(!((typeof data == "number") && (!(data % 1) && !isNaN(data)))){const err0 = {instancePath,schemaPath:"#/definitions/nonNegativeInteger/type",keyword:"type",params:{type: "integer"},message:"must be integer"};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(typeof data == "number"){if(data < 0 || isNaN(data)){const err1 = {instancePath,schemaPath:"#/definitions/nonNegativeInteger/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}validate1.errors = vErrors;return errors === 0;}
KERNEL TRACE:
   0 kernel.schema.get(tuvren.agent.v1) -> "null"
   1 kernel.schema.register({incorporationRules,paths,schemaId}) -> "tuvren.agent.v1"
   2 kernel.thread.create(b46bec63.., tuvren.agent.v1, 077e95bf..) -> {}
   3 kernel.thread.get(b46bec63..) -> {}
   4 kernel.schema.get(tuvren.agent.v1) -> {}
   5 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"0bf9d155.."}
   6 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"0bf9d155.."}
   7 kernel.node.get(0bf9d155..) -> {}
   8 kernel.tree.resolve(5ca34d0c.., turn.lineage) -> "null"
   9 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"0bf9d155.."}
  10 kernel.node.get(0bf9d155..) -> {}
  11 kernel.tree.resolve(5ca34d0c.., turn.lineage) -> "null"
  12 kernel.turn.create(9f200a25.., b46bec63.., 077e95bf.., null, 0bf9d155..) -> {"headTurnNodeHash":"0bf9d155.."}
  13 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"0bf9d155.."}
  14 kernel.node.get(0bf9d155..) -> {}
  15 kernel.tree.resolve(5ca34d0c.., messages) -> "[0]"
  16 kernel.tree.resolve(5ca34d0c.., context.manifest) -> "null"
  17 kernel.tree.resolve(5ca34d0c.., turn.lineage) -> "null"
  18 kernel.run.create(9c52bbf5.., 9f200a25.., 077e95bf.., tuvren.agent.v1, 0bf9d155.., [1]) -> {"status":"running"}
  19 kernel.run.beginStep(9c52bbf5.., incorpor..) -> {}
  20 kernel.staging.stage(9c52bbf5.., <46B>, input_message, message, completed) -> {}
  21 kernel.staging.stage(9c52bbf5.., <202B>, manifest, context_manifest, completed) -> {}
  22 kernel.staging.stage(9c52bbf5.., <52B>, turn_lineage, turn_lineage, completed) -> {}
  23 kernel.staging.stage(9c52bbf5.., <33B>, runtime_status, runtime_status, completed) -> {}
  24 kernel.store.put(<66B>) -> "7921a81b.."
  25 kernel.run.completeStep(9c52bbf5.., incorpor.., 7921a81b..) -> {"turnNodeHash":"bee8e902.."}
  26 kernel.run.complete(9c52bbf5.., completed, undefined) -> {}
  27 kernel.turn.updateHead(9f200a25.., bee8e902..) -> "undefined"
  28 kernel.branch.setHead(077e95bf.., bee8e902..) -> {}
  29 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"bee8e902.."}
  30 kernel.node.get(bee8e902..) -> {}
  31 kernel.tree.resolve(fcc4b670.., messages) -> "[1]"
  32 kernel.tree.resolve(fcc4b670.., context.manifest) -> "018c3cd9.."
  33 kernel.store.get(018c3cd9..) -> {}
  34 kernel.tree.resolve(fcc4b670.., turn.lineage) -> "65ac2178.."
  35 kernel.store.get(65ac2178..) -> {}
  36 kernel.store.get(405a2a0d..) -> {}
  37 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"bee8e902.."}
  38 kernel.node.get(bee8e902..) -> {}
  39 kernel.tree.resolve(fcc4b670.., messages) -> "[1]"
  40 kernel.tree.resolve(fcc4b670.., context.manifest) -> "018c3cd9.."
  41 kernel.store.get(018c3cd9..) -> {}
  42 kernel.tree.resolve(fcc4b670.., turn.lineage) -> "65ac2178.."
  43 kernel.store.get(65ac2178..) -> {}
  44 kernel.store.get(405a2a0d..) -> {}
  45 kernel.run.create(d239895c.., 9f200a25.., 077e95bf.., tuvren.agent.v1, bee8e902.., [1]) -> {"status":"running"}
  46 kernel.run.beginStep(d239895c.., iterate) -> {}
  47 kernel.staging.stage(d239895c.., <113B>, interrup.., turn_lineage, completed) -> {}
  48 kernel.staging.stage(d239895c.., <85B>, message_1_0, message, completed) -> {}
  49 kernel.staging.stage(d239895c.., <200B>, interrup.., turn_lineage, completed) -> {}
  50 kernel.run.complete(d239895c.., failed, undefined) -> {"turnNodeHash":"e5241902.."}
  51 kernel.branch.setHead(077e95bf.., bee8e902..) -> {}
  52 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"bee8e902.."}
  53 kernel.node.get(bee8e902..) -> {}
  54 kernel.tree.resolve(fcc4b670.., messages) -> "[1]"
  55 kernel.tree.resolve(fcc4b670.., context.manifest) -> "018c3cd9.."
  56 kernel.store.get(018c3cd9..) -> {}
  57 kernel.tree.resolve(fcc4b670.., turn.lineage) -> "65ac2178.."
  58 kernel.store.get(65ac2178..) -> {}
  59 kernel.store.get(405a2a0d..) -> {}
  60 kernel.branch.get(077e95bf..) -> {"headTurnNodeHash":"bee8e902.."}
  61 kernel.node.get(bee8e902..) -> {}
  62 kernel.tree.resolve(fcc4b670.., messages) -> "[1]"
  63 kernel.tree.resolve(fcc4b670.., context.manifest) -> "018c3cd9.."
  64 kernel.store.get(018c3cd9..) -> {}
  65 kernel.tree.resolve(fcc4b670.., turn.lineage) -> "65ac2178.."
  66 kernel.store.get(65ac2178..) -> {}
  67 kernel.store.get(405a2a0d..) -> {}
  68 kernel.run.create(14eccd9e.., 9f200a25.., 077e95bf.., tuvren.agent.v1, bee8e902.., [1]) THREW memory_backend_active_run_turn_head_mismatch: stored active runs must stay aligned with the current turn head
EVENT SEQUENCE:
   0 {"type":"turn.start"}
   1 {"type":"state.checkpoint"}
   2 {"type":"state.snapshot"}
   3 {"type":"iteration.start"}
   4 {"type":"message.start"}
   5 {"type":"tool_call.start"}
   6 {"type":"tool_call.args_delta"}
   7 {"type":"tool_call.done","name":"echo_number"}
   8 {"type":"message.done"}
   9 {"type":"iteration.end"}
  10 {"type":"error","error":{"message":"Code generation from strings disallowed for this context"}}
  11 {"type":"error","error":{"code":"memory_backend_active_run_turn_head_mismatch","details":{"activeTurnNodeHash":"bee8e9023e2b8e1887d27def3fe0d09cf16831618532dde42e41d78ff80e278e","runId":"14eccd9e-bb5f-4b31-a4c3-4405eca5e2da","status":"running","turnHeadTurnNodeHash":"e52419027416307aeb4cf07cf69642c7327814016ca2f2fe39875b52c2da2289","turnId":"9f200a25-8f95-4825-a7ee-fdb4067e6ac5"},"message":"stored active runs must stay aligned with the current turn head"}}
SUMMARY: {
  "eventCount": 12,
  "executions": 0,
  "providerCalls": 1,
  "resultStatus": "failed",
  "executionStatus": {
    "activeAgent": "agent",
    "iterationCount": 1,
    "manifest": {
      "byRole": {
        "tool": 0,
        "user": 1,
        "system": 0,
        "assistant": 0
      },
      "toolCalls": {
        "total": 0,
        "byName": {}
      },
      "extensions": {},
      "toolResults": {
        "total": 0,
        "byName": {}
      },
      "messageCount": 1,
      "tokenEstimate": 3,
      "turnBoundaries": [
        0
      ],
      "lastUserMessageIndex": 0,
      "lastAssistantMessageIndex": -1
    },
    "phase": "failed"
  },
  "resultError": {
    "code": "memory_backend_active_run_turn_head_mismatch",
    "details": {
      "activeTurnNodeHash": "bee8e9023e2b8e1887d27def3fe0d09cf16831618532dde42e41d78ff80e278e",
      "runId": "14eccd9e-bb5f-4b31-a4c3-4405eca5e2da",
      "status": "running",
      "turnHeadTurnNodeHash": "e52419027416307aeb4cf07cf69642c7327814016ca2f2fe39875b52c2da2289",
      "turnId": "9f200a25-8f95-4825-a7ee-fdb4067e6ac5"
    },
    "message": "stored active runs must stay aligned with the current turn head",
    "name": "TuvrenRuntimeError"
  }
}
```

## Owner rulings (2026-10-29)

| Decision | Ruling |
| :--- | :--- |
| Sequencing | Two epics: EPIC-DK (portable core) after DF in wave 2, then EPIC-DL (published testkit) after DJ and before CB |
| Legacy `register*Suite` suites | Retire into plans with a `claimId` obligation audit |
| Package name | `@tuvren/backend-testkit` |
| Trust model | Allow the in-process transport and a host-supplied process boundary (ADR amending ADR-0075, ADR-0076, ADR-0081) |
| Portability floor | Replace Node-specific APIs with web-standard ones wherever needed. Interpretation: the kit and every package on its import path (`kernel-protocol`, `kernel-runtime`, `backend-shared`, `backend-memory`). `AsyncLocalStorage` has no web standard, so the DK spike designs it out or reports the narrowest remaining dependency. |
| Item 3 validation | One codegen-free validator, checked at registration, with `defineTool`/`jsonSchema` unified |
| Failed-iteration visibility | Hidden: rewind both heads in one transaction |
| #156 | Close with evidence and the stated gap; add the host guide section and the `nonRetryable` TSDoc line |
| Deno target | Deno is no longer a target; workerd takes the isolate lane. |
| Merges | Merges are delegated to the session. |
