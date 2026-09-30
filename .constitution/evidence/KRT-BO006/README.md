# KRT-BO006: aimock upgrade and measured legacy failure categories

Aimock 1.43.0 was installed through native Bun CLI in the private host package and verified against the published registry, installed ESM declarations, host manifest, lockfile and separately patched stack record. The exported isChatCompletionBody guard narrows every journal body read; the original json_schema and continuation assertions remain. The lead confirms all 79 original matcher/expected-value assertions and their actual subjects in the source diff. No new cast, any, non-null assertion or suppression was introduced.

The six new journal cases include actual recorded fine-tuning payload and oversized-request cap-marker assertions. The fresh fixer demonstrated that missing entries, missing bodies and wrong payloads fail both integration cases; the former versions passed those mutations. Final native plain and isolated runs each pass 135 tests across seven files with 1,089 expectations, including six journal cases with 66 expectations. Source typecheck, lint, all 33 full verification steps, changeset coverage, and the declared live build/doctor/streaming recipe pass. Four existing OXC warnings remain, with zero constitution errors on the combined tree.

## Historical evidence and A4

Original clause preserved in the ticket: "the seven draft failures each have a recorded cause". The original draft, exact inputs and failure list cannot be recovered. Independent execution judgment and plan amendment A4 replace that assumed execution premise with causal reproduction of every named category, exact observed counts, and explicit disclosure of historical limits. The exact recoverable PR130 head is 7ec8ee0e4c598027a280061867e508e3484d5861; its CI stopped at five JournalBody type errors before running tests.

Clean snapshot controls reproduce two steering failures caused by the pre-A2 SDK constructor split and two approval failures caused by the bundled OpenAI provider 3.0.118. Removing PostgreSQL connection variables adds two setup failures: observed maximum six, never seven. The controlled approval comparison is repeated with native Bun package declarations and clean builds: OpenAI 3.0.53 gives 129/0; changing only its declaration to 3.0.118 gives the same two approval failures in ordinary and isolated modes; restoring 3.0.53 returns 129/0 and the original lock bytes. Its required transitive graph changes are recorded.

The provider starts both parallel tool calls before completing either. The runtime synthesizes one start/done pair per call, so its sequence validator reports invalid_stream_event. BO keeps OpenAI 3.0.53. Provider stream-order compatibility is routed to Stage 3/4 before a later bump; this epic adds no such production fix. The original seventh identity and exact historical partition remain unverified; no seven-cause claim or inferred 2+2+3 partition is accepted.

The earlier exploratory controls mixed a post-A2 compiled build with some legacy sources and could not reproduce approval failures; that result is not a complete historical baseline. The first worker's claim that SWC was an aimock dependency and its inferred historical partition were rejected. Independent lock comparison instead proves native Bun pruned 16 unused optional-peer SWC entries and retained every other resolution/metadata unchanged. The decisive native CLI verification supersedes the exploratory manual pin method.

## Reproducible inputs and commit separation

The producing commit is parent 672711d plus the complete code source.patch and attached stack-source.patch. Proof applies to that declared combined snapshot, not the bare parent. Code/evidence/ticket bookkeeping are committed first; the stack-only patch follows immediately. The solely expected intermediate TS-004 aimock 1.15.1/1.43.0 mismatch is retained as a negative control; final combined validation clears it. Each commit receives independent review.

The archive retains actual command/exit receipts, source patches, API probes, A4, mutation procedures, exact PR130 control inputs, and native CLI provider comparison inputs/hashes. Scratch paths are recorded historical facts. Replays require disposable scratch and current repository environment; do not treat an intentionally failing legacy control as a release gate. All control copies used independent workspace links and test cleanup; no service lifecycle was embedded in runners.



Exact native outputs and source patches are retained in transcripts.tar.gz. Extract it in disposable scratch; transcript-index.json pins every member by SHA-256 and byte count. Historical paths remain labeled recorded facts; repeat the prescribed commands in the current repository environment.
