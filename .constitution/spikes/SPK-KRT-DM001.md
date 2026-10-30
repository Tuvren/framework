# Spike report: KRT-DM001 codegen-free validator and single-transaction head rewind

## Effort budget

- **Budget:** 3 story points, the effort of KRT-DM001.
- **Spent:** 3 story points.
- **Cut:** Exhaustive JSON Schema Test Suite coverage, browser and isolate execution, whole-repository schema enumeration, large-schema benchmarks, and a concurrent integration prototype. The measurements cover representative repository schemas and targeted counterexamples, not a proof of complete dialect conformance. No production implementation or kernel authority change was attempted.

## Question

- **Owner:** KRT-DM001 in `.constitution/tasks/epics/EPIC-DM-tool-admission-integrity-and-codegen-free-validation.yaml`.
- **Decision:** Select an interpreting validator, its validation-failure `details` projection, and a wrapper location for ADR-0083. Determine whether the existing syscalls can atomically return the branch and turn heads to the stable head after a failed run.

## Context and objective

- **Trigger:** ADR-0083 decisions 1, 2, 4, and 5; `.constitution/tech-spec/stack.yaml`; guidelines section 5.12.
- **Target:** Validate tool input and output, MCP advertisements and output, and structured output across drafts 7, 2019-09, and 2020-12 without string-based code generation. Check declared schemas at registration and schemas introduced during a turn before the provider call.
- **Affected surfaces:** `@tuvren/core`, `@tuvren/runtime`, `@tuvren/runner-react`, `@tuvren/mcp-client`, `@tuvren/provider-bridge-ai-sdk`, and `@tuvren/sdk`. The ReAct turn and external MCP server flows require the same decisions.

## Codebase baseline

- The working tree started clean at commit `89c0e29211150b0d3f9f094c29801533a2141202`. Runtime tool validation uses one Ajv 8.18.0 instance with `allErrors: true, strict: false`, caching compiled object schemas by identity. The runner and bridge select Ajv by `$schema`; the MCP client compiles advertised input and output when listing tools.
- `typescript/sdk/src/lib/schema-authoring.ts` exposes synchronous helper and `CustomSchema.validate` surfaces. A plain-schema helper with no host validator accepts all values. Host validators take precedence and must retain that behavior.
- The runtime's Ajv failure projection is an array of `{ instancePath, keyword, message, params, schemaPath }` from `typescript/runtime/src/lib/tool-execution-validation.ts:55-63`. This is not a cross-language authority shape; ADR-0083 permits a breaking replacement.
- Runner, MCP client, bridge, runtime, and SDK have a required `@tuvren/core` peer dependency. The runner and MCP client do not depend on runtime. The bridge lists `@tuvren/runtime` only as a development dependency for its tests, not as a production dependency. Core has no dependency on these consumers, so a core wrapper introduces no production package cycle.
- `run.complete(failed)` runs `maybeCheckpoint` and marks the run failed in one backend transaction in `typescript/kernel/runtime/src/lib/runtime-kernel-runs.ts:163-211`. With staged results or an event, `checkpointRun` writes a TurnNode and advances both heads, then clears staging in that transaction. See `runtime-kernel-lineage.ts:967-1034`.
- `failTrackedRunWithoutBranchAdvance` then calls only `branch.setHead(stableHead)` in a second transaction. It leaves the turn head on the failed checkpoint. The supplied reproduction trace shows the later `run.create` failing with `memory_backend_active_run_turn_head_mismatch`; the turn-parent check can reject the next turn with `kernel_runtime_turn_parent_start_mismatch`.

### Production compile and helper inventory

The table records production call sites and their required placement under ADR-0083 decision 2. Conformance adapters and testkits also compile Ajv, but they are tooling and are outside the production migration.

| Surface and present site | Placement after the change |
| --- | --- |
| Runtime input and output: `typescript/runtime/src/lib/tool-execution-validation.ts:37-50`; callers include `tool-execution-resolution.ts:91,381` and `tool-execution-single.ts:149`. | Prepare each plain input and output schema when its tool is registered. Cache the prepared validator for admission, resumed edits, and output validation; do not compile on first tool invocation. |
| ReAct structured output: `typescript/runners/react/src/lib/react-runner.ts:633-675,728` compiles after a model response. | Prepare agent configuration schemas at registration. Prepare a per-request schema or the effective schema supplied or replaced by an `aroundModel` hook before the provider call using it; retain that prepared validator for the response. |
| MCP advertised input and output: `typescript/tools/mcp-client/src/lib/mcp-tool-source.ts:396-412,555-556`. | Prepare both schemas during `refresh` when `listTools` advertisements are translated, before publishing the tools. Report an invalid advertisement as `tool_schema_invalid`; do not defer preparation until execution. |
| AI SDK bridge structured output: `typescript/providers/bridge-ai-sdk/src/lib/ai-sdk-provider-bridge.ts:886-905,918-961` compiles while parsing the provider response. | Reuse the prepared agent configuration validator, or prepare an effective request schema before the bridge invokes the provider. Both generate and stream paths must use the prepared validator. |
| SDK `jsonSchema` and `defineTool`: `typescript/sdk/src/lib/schema-authoring.ts:241-256,378-392` do not compile; the plain-schema path silently succeeds. | Route plain schemas through the same prepared validator at registration. Preserve user-supplied `validate`, Zod, Standard Schema, and other host-validator precedence. The synchronous public helper contract needs the resolution described in Options and trade-offs. |

### Kernel specification and transaction boundary

The kernel specification is ambiguous about checkpoint turn-head mutation. Section 5.3 says the turn head advances as TurnNodes are created and says it is updated through `turn.updateHead`; section 5.5 lists the Branch Head, but not the Turn head, in the atomic checkpoint without assigning that update to `turn.updateHead`. Section 5.6 requires a reactive checkpoint for unanchored staged results. Both the TypeScript and Rust kernels move the turn head inside the checkpoint, and all four TypeScript backends enforce active-run alignment with it. No kernel conformance plan observes the turn head after a checkpoint. The Stage 3 pass must settle and record the rule through the kernel authority packet and plans.

The existing syscalls cannot rewind both heads in one kernel transaction. `branch.setHead` and `turn.updateHead` each start their own `backend.transact` in `typescript/kernel/runtime/src/lib/runtime-kernel.ts:237-330,735-760`. Backward `branch.setHead` atomically archives the abandoned segment and handles affected runs, but does not update the turn. `turn.updateHead` checks that the target descends from the turn start and preserves dependents, but does not update the branch. Calling both exposes an intermediate state and cannot provide one transaction.

The smallest operation satisfying the narrow post-completion rewind is a kernel compound operation that takes the relevant branch, turn, and stable head, performs the existing backward archival and run handling, and updates both heads within one transaction. It must verify their association, thread membership, ancestry, turn-start legality, dependent lineage, and stale or concurrent changes; the Stage 3 authority pass owns the precise signature and preconditions.

This is a separate, smaller option from the compound fail-and-rewind operation: it atomically rewinds both heads after failed completion, but leaves the failed checkpoint visible between the two transactions.

There is a further visibility gap: if `run.complete(failed)` commits its reactive checkpoint before that operation, a concurrent durable read can observe failed work between transactions. To satisfy ADR-0083 decision 4's literal “never observable” rule, recommend one compound `run.failAndRewind` operation, or equivalent, that atomically completes the run, preserves the reactive checkpoint and archival obligations, and leaves both original heads at the stable head. This name is a proposal, not an existing syscall. Kernel authority must define crash and concurrency semantics; the epic cannot implement it within its declared scope.

## Options and trade-offs

### Measurement method and schema families

Experiments ran offline using probe scripts outside the repository, not committed, with Node 24.22.1. The candidate and fallback ran with `--disallow-code-generation-from-strings`; a `new Function` probe raised `EvalError`. The installed packages were `@cfworker/json-schema` 4.1.1, `@hyperjump/json-schema` 1.18.0, and Ajv 8.18.0. Ajv ran without the flag for the semantic baseline; under the flag it raised `EvalError` for every sampled compilation. A fetch stub rejected network access. The installed package documentation and source supplied the API signatures; no package was added to the repository.

For each row, pass means that the sampled valid value was accepted and the sampled invalid value was rejected under the flag. It does not mean the entire family or dialect passed an exhaustive suite. Ajv matched those validity results without the flag. Candidate and fallback diagnostic fields differ from Ajv in every invalid case, as described in the projection section.

| Repository schema family and sample | Candidate | Fallback | Difference from Ajv |
| --- | --- | --- | --- |
| Runtime input, `typescript/runtime/test/server-execution-class.ax005-audit.test.ts:155-160`: number `value`, required, no extra properties; `{value:2}` and `{bad:"field"}`. | Pass | Pass | Candidate emits additional nested boolean-schema diagnostics. |
| Runtime output, same file around line 198: number `count`, required, no extra properties; `{count:3}` and `{count:"x"}`. | Pass | Pass | Candidate also reports the declared but invalid `count` as an additional property; Ajv and fallback report its type failure only. |
| ReAct draft 7, `typescript/runners/react/test/react-runner-structured-output.test.ts:114`, and AI SDK bridge, `typescript/providers/bridge-ai-sdk/test/ai-sdk-provider-bridge-tool-calls.test.ts:65`: required string `answer`; string versus number. | Pass | Pass | Same validity; diagnostic shape differs. |
| ReAct 2019-09, `react-runner-structured-output.test.ts:307`: required string `answer`, `unevaluatedProperties: false`; a valid object versus one with an extra property. | Pass | Pass | Same validity; fallback identifies the extra property's instance location rather than Ajv's parent path and parameter. |
| ReAct 2020-12, `react-runner-structured-output.test.ts:170`: one string `prefixItems` entry and `items: false`; `["x"]` versus `["x","bad"]`. | Pass | Pass | Same validity; diagnostics differ. A separate 2020-12 dynamic-reference counterexample fails for the candidate below. |
| MCP client input and output, `typescript/tools/mcp-client/test/mcp-client.test.ts:193-207`: required string `message` or `echoed`; string versus number. | Pass | Pass | Same validity; diagnostic shape differs. |
| Provider testkit MCP echo input and output and search input, `typescript/providers/testkit/src/lib/mock-mcp-server.ts:68-80`: Zod 4.4.3 `message`, `echoed`, and `query` strings converted with the MCP SDK 1.29.0 draft-7 input or output conversion settings; string versus number. | Pass | Pass | The output schema has `additionalProperties: false`; the candidate repeats the false additional-property diagnostic. |
| Tools conformance, `spec/conformance/tools/plans/tool-contracts-extended.json:21` and its `provider-stream-tool-call-native` scenario in `spec/conformance/engine/scenarios/runtime-api-scenarios.json`: required string `query`; string versus number. | Pass | Pass | Same validity; diagnostic shape differs. |
| Engine conformance, `spec/conformance/engine/plans/runtime-api-callables-extended.json:307` and `tool-execute-search.toolResultSchema` in the same scenario file: `{ok:true,source:"shared scenario"}` versus `{ok:false,source:5}`. | Pass | Pass | Candidate adds false additional-property diagnostics for both declared invalid properties; fallback and Ajv report the failing `const` and `type`. |

The JSON conformance schemas were read directly from the scenario file. The TypeScript test schemas were transcribed from the cited declarations. The provider testkit's Zod shapes were converted with `toJSONSchema` using draft-7 and the SDK's input/output settings. The synthetic probes below extend those real schemas to cover behaviors absent from the sampled tests.

| Probe | Candidate under flag | Fallback under flag | Ajv without flag |
| --- | --- | --- | --- |
| Drafts 7, 2019-09, and 2020-12: `#/definitions/num` and relative `child` references to an embedded `$id` subschema; number versus string. | Pass in all three | Pass in all three | Pass in all three |
| Draft 7: `child.json` relative to a root `$id`, with the child schema explicitly registered before validation. | Pass | Pass | Pass |
| Boolean `true` and `false` schemas. | Pass | Pass | Supported by the baseline; not separately timed. |
| Unknown `x-vendor-option` keyword and unknown format. | Ignored; normal type validation works | Ignored; normal type validation works | Ignored with `strict: false`; unknown formats produce warnings unless logging is suppressed. |
| Known `format: "email"` with `"not-email"`. | Rejects | Accepts with format assertion disabled | Accepts without `ajv-formats` |
| Invalid schema `{type:"wrong"}` and an unresolved `$ref` nested in an absent property. | Constructor accepts both; the missing reference is not discovered when the absent property is validated. | Preparation rejects both in all three drafts. | Compilation rejects both. |
| Draft 2020-12 root `$dynamicAnchor: "node"`, required `value`, and `properties.next.$dynamicRef: "#node"`: `{value:1,next:{}}`. | **Fail:** accepts invalid nested object | Pass: rejects it | Pass: rejects it |
| Frozen `{type:"object"}`. | Constructor throws when adding `__absolute_uri__` | The prepared clone validates | The compiled clone validates |

Hyperjump reports an unresolved reference during preparation as a plain `TypeError`; the wrapper must map it to the typed schema error.

The fallback was explicitly configured with `setShouldValidateFormat(false)` and tested with format handlers loaded in all three dialects. That setting matches this Ajv baseline for the sampled known format. It is global library state, so coexistence with another Hyperjump consumer needs an isolation decision. The candidate asserts known formats with no per-validator switch in the inspected API and mutates schemas while dereferencing; runtime snapshots are deeply frozen. Its missing-reference and dynamic-reference failures make it unsuitable for the ADR's registration and 2020-12 requirements.

The fallback exposes asynchronous `validate(schemaUri)` preparation and a synchronous returned validator. It uses a shared schema registry: registering two simultaneous schemas with the same explicit `$id` raised a duplicate-registration error. In a sequential test, compiling each schema, unregistering it, and then interleaving calls to both prepared validators retained independent string and number semantics. This does not prove safe concurrent isolation, cleanup of all aliases, or isolation from host code using the same library. Preparation can also resolve URI references through library loaders; production must define an explicit resolver policy and avoid implicit network retrieval.

The fallback's asynchronous preparation is a material contract gap. `defineTool` returns synchronously, and `CustomSchema.validate` returns a synchronous `ValidationResult`; a standalone caller can invoke that method before asynchronous registration exists. Preparing at an asynchronous tool-registration boundary makes subsequent validation synchronous, but does not by itself satisfy an immediate standalone call. KRT-DM006 and the ADR patch must resolve that public behavior without silently accepting input, introducing another production validator, or claiming that asynchronous work can complete synchronously.

### Validation-failure details

Recommend a serializable array of `{ instanceLocation: string, keywordLocation: string, keyword: string }` for built-in JSON Schema failures in both `tool_input_validation_failed` and `tool_result_validation_failed`. Derive it from Hyperjump's BASIC result: `instanceLocation` is its JSON Pointer URI fragment, `keywordLocation` is its `absoluteKeywordLocation`, and `keyword` is its keyword URI. For a schema with no declared base, strip the wrapper's synthetic root URI prefix, leaving the `#` fragment; preserve declared or referenced resource URIs. Sort by those three strings for deterministic ordering and preserve duplicate entries. For the runtime output example, the projected entry is `{ "instanceLocation": "#/count", "keywordLocation": "#/properties/count/type", "keyword": "https://json-schema.org/keyword/type" }`.

This projection intentionally does not invent Ajv's `message` or `params`; a false boolean schema can report `https://json-schema.org/evaluation/validate` as its keyword. Hyperjump's BASIC output format is documented as experimental in the installed 1.18.0 README, even though the compiled validator accepts `"BASIC"`. Pin the version, own the projection in core, and test the adapter before adopting it. Host-validator error payloads remain their own shapes. ADR-0083 decision 7 already classifies the built-in details change as breaking and requires a minor release.

Under the no-codegen flag, a scratch projection of the invalid runtime input and output produced the proposed fields and ordering. Two preparations with different synthetic root URIs produced identical projected input errors. A property named `a/b~c` produced the escaped instance location `#/a~1b~0c`. This checks the proposed adapter on those cases, not the long-term stability of the upstream experimental format.

### Small latency comparison

On the same Node 24.22.1 process type, the runtime input schema was prepared once. Each run used 10,000 warmup validations followed by five runs of 100,000 validations, alternating `{value:42}` and `{bad:"field"}`; all-error reporting was enabled. Candidate and fallback used the no-codegen flag; Ajv necessarily ran without it. Median microseconds per validation were 0.850 for the candidate, 1.761 for the fallback, and 0.106 for Ajv, approximately 8.0x and 16.6x the Ajv time respectively. These are local microbenchmarks, not end-to-end latency, throughput guarantees, compile-time measurements, or a comparison on production hardware.

## Recommendation

- **Chosen option:** Recommend `@hyperjump/json-schema` 1.18.0 and a focused `@tuvren/core/schema-validation` subpath, subject to the owner ruling required by ADR-0083 when the primary candidate fails. The stop condition is not met: the fallback passed the sampled local-reference cases for all three required drafts under the flag. This is a recommendation, not authorization to adopt it before the ruling.
- **Why it fits:** The fallback interpreted all sampled repository schemas and local and relative references under the no-codegen flag, rejected the measured malformed schemas and unresolved references at preparation, and handled the 2020-12 dynamic-reference counterexample. The core location shares one validator and one projection without introducing a production cycle.
- **Wrapper work:** Add the subpath entry to `typescript/core/tsup.config.ts`, its `types`, `import`, and `default` entries to the core exports map, and a source path to `tsconfig.base.json`. Declare the pinned runtime dependency through Bun. Hyperjump 1.18.0 declares seven caret-ranged runtime dependencies: `@hyperjump/json-pointer`, `@hyperjump/json-schema-formats`, `@hyperjump/pact`, `@hyperjump/uri`, `content-type`, `just-curry-it`, and `uuid`. It also requires the peer `@hyperjump/browser` `^1.1.0`; every `@tuvren/core` consumer would inherit this dependency footprint. `@tuvren/core` has no dependencies today. `tools/scripts/api-freeze-gate.ts:189-230` derives every core subpath from the exports map and expects `src/<subpath>/index.ts`; it will automatically include the entry in the freeze snapshot. Review and record the API surface through the existing gate and release policy.
- **Rejected options:** Reject `@cfworker/json-schema` 4.1.1 for missed 2020-12 dynamic references and deferred invalid-schema and reference errors. Reject per-package validator implementations because they duplicate preparation, resolver, and diagnostic policy. Reject runtime Ajv because it cannot compile under the required flag.
- **Required qualification:** Resolve the fallback's asynchronous preparation versus synchronous SDK helper contract, global registry and format settings, and loader policy before implementation. The measured samples do not establish browser or isolate portability or comprehensive JSON Schema conformance.

## Downstream impact

- **ADRs to write or update:** After the owner rules on the fallback, patch ADR-0083 decision 1 with the selected validator, core subpath, details projection, format policy, and unresolved helper contract resolution. Patch `.constitution/tech-spec/stack.yaml` to replace the assumed candidate with the ruled dependency and its pin. A separate Stage 3 ADR and kernel authority packet and plans must define the compound failure operation and settle the ambiguous checkpoint turn-head rule.
- **Tickets unblocked:** The validator measurements inform KRT-DM004 and its downstream KRT-DM005 and KRT-DM006, conditional on the owner ruling and resolution of the synchronous helper contract. KRT-DM003 is **blocked**, not unblocked: its explicit stop condition requires deferral when a kernel operation is needed.
- **Register entry closed:** None. The ADR's candidate and wrapper assumptions remain subject to the required fallback ruling.
- **Tickets to add or split:** Defer KRT-DM003 until a separately scoped kernel authority and implementation change supplies the compound operation. Add or split work for the synchronous helper contract and safe Hyperjump registry, configuration, resolver, and cleanup behavior if those cannot fit the existing validator tickets.
- **Spec edits required:** Record the failure visibility rule and additive `subsequentErrors` field through the framework authority specified by ADR-0083 decisions 4 and 5. Update kernel authority and conformance before changing kernel behavior. Add validator and rewind conformance for dialects, local and relative references, dynamic references, malformed schemas, reused IDs, concurrent failure visibility, and recovery; preserve the independent Ajv-based tooling oracle.

## Verification

- The lead ran `bun install --frozen-lockfile` in the worktree. At `b1cdad2`, `bun run check --base=origin/master` exited 0: every authority gate passed, and Nx affected ran no tasks. The earlier `bun run check` used the stale local `master` base and failed before dependencies were installed.
- The milestone commit changes this spike report and the epic file's bookkeeping: ticket statuses and the OD-23 and OD-24 entries. It changes no file under `typescript/`.
