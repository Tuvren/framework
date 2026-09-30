# KRT-BO001 buffer ownership evidence

Historical producing parent: dff2df9f8dd5dd37fe4054081bcf22479745bd82. All post-fix commands ran against that parent plus source.patch, which includes the complete source, new-test and changeset diff. The manifest commit identifies the parent, not a claim that the bare parent passed. The attached patch and its digest identify the tested implementation without a circular self-hash.

Runtime controls: repository devenv profile Bun 1.3.10; candidate Bun 1.4.2. The unchanged 77 tests pass on the former and fail exactly three dataView comparisons on the latter. New ownership tests run red before the patch (1 pass,4 fail); both final full suites pass82 (77 unchanged +5 new). Commands with absolute paths in the retained logs are historical transcripts. Reproduction: apply source.patch to the recorded parent, evaluate its devenv environment, and set BO_CANDIDATE_BUN to an immutable Bun1.4.2 binary. From the memory package run LC_ALL=C bun test and LC_ALL=C "$BO_CANDIDATE_BUN" test.

The 22 malformed-write control probes are recorded supplementary measurements, not durable regression coverage claims; their temporary scratch helper is not shipped. The two rejection-parity logs must be byte-identical. Field-inventory measurements record ten caller buffers without claiming a reusable conformance authority.

Lead verification uses the full worktree devenv environment. It passes all eleven commands listed in lead-checks.json, including source-only typecheck, declaration build, package lint, direct patch changeset coverage, original test-file preservation, the host recipe, and bun run check. PostgreSQL was started by the lead for affected tests. Cold-check attempts lacking generated interop bindings or PGHOST are environment failures and are not acceptance passes.

The live recipe passes launch, doctor and drive and captures the exact streaming scenario line. It is supplementary host-regression proof, not a substitute for the ownership assertions. The fixture scenario exits and leaves no persistent memory state.

Worker residual claims about backend-shared decoder paths are not adopted here: memory owns its state-validation and run-span implementation, and those two shared decoder functions are not used by the memory call path. No other backend files changed.

To inspect exact retained outputs, run tar -xzf transcripts.tar.gz in a disposable directory. transcript-index.json lists each archive member's original byte count and SHA-256. The source.patch and lead-checks.json discussed above are archive members. The bundle preserves exact outputs while keeping the milestone diff reviewable. The ordinary recipe can be repeated from the repository root; use its prescribed commands rather than historical absolute paths.
