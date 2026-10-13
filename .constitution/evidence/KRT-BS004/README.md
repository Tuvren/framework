# Kernel support native admission evidence

M8 admits only `typescript/kernel/grpc-client`. The other four BS roots retain Biome ownership; M9/M10 and release verification remain pending.

`m8-summary.json` identifies the measured working-tree candidate based on `47061b11fd24aabc4c55eec358d3014c4bc80354`, its seven file hashes and patch digest. That base SHA does not claim to contain the candidate bytes. The admission commit contains those exact product bytes together with this evidence.

`m8-suppression-disposition.json` reconciles both original identities and reasons: gRPC retires its needed Biome directive atomically with native admission, with no firing native counterpart; testkit retains its original directive. The historical BS002 evidence remains unchanged.

`m8-reports.tar.gz` preserves 118 indexed files: complete command streams, pre-admission suppressed/unsuppressed reports, actual per-project code/JSON selections, effective preset configurations, signature and runtime checks, cache probes and replay scripts. Its internal `digest-index.json` records every stream's digest and byte count. The outer manifest binds the exact archive bytes.

The candidate's three live native projects have 48 raw code-owner entries and 21 raw JSON-owner entries, each with exactly one owner. The gRPC selection contains six code files and seven JSON files. These measured counts belong to M8, not later admissions. Independent raw ownership checks avoid deduplicating overlapping selections.

The installed shipped policy comparison covers every effective field, including rule options/severities, environment, globals, plugins, settings and categories. The measured enabled set is 473 rules: 55 type-aware and 418 others. Historical counts are not quotas. The root policy and dependencies are unchanged.

The owned lint target preserves inherited helper inputs, declares codegen, hashes direct generated TypeScript outputs, and covers 14 imported dependency sources plus root TypeScript configs. Actual Nx graph/hasher probes prove clean output restoration, repeat cache reuse, changed generated-output hashing and exact byte restoration. Ordinary typecheck remains source-only.

A11/shared proposed OD-09 applies to the gRPC client's honest async maintenance rejection. The original typed rejected Promise is awaited; class, code, message and required Promise signature remain unchanged. An unchanged-preset fixture records why direct async throw triggers `require-await`, while the actual awaited rejection passes both rules. No scheduling or Promise-identity guarantee is introduced.

To replay, load the repository environment, extract a fresh archive outside the repository, and follow its `REPLAY.md` from the candidate repository root. Set `TUVREN_BS_EVIDENCE` to the extraction directory. Use the shared runtime lock for compiler/type-aware/gate commands; keep all tracked files and index state frozen until broad commands finish. The cache probe changes only owned ignored outputs and restores them in `finally` blocks. Services are managed by the session owner.

All worker eight-gate reports and additional preset/partition controls passed on the candidate. The epic records the lead's assembled-tree replay. Independent committed-milestone review is required before continuing. This snapshot makes no claim that BS004 is complete.
