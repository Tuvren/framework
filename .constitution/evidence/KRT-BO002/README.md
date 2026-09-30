# KRT-BO002 atomic environment and Weaver migration

Producing parent: f804f0f075a2a0c9907e3ba646788f1976a06625 (the compatibility prerequisite). Apply migration-source.patch to this parent to reproduce the measured M2 source/env tree. The exact patch includes the refreshed shared nixpkgs lock and Weaver manifest rename/reader together; no Bun-only pin was added. PostgreSQL remains explicitly major17.

Observed refreshed tools: Bun1.4.2, Weaver0.25.1, PostgreSQL17.11, Node24.20.0, Buf1.72.0, Protobuf36.1; nixpkgs revision c2f38fe7f9e04d9aadd354d380f2bd40531d9737. Four declared telemetry outputs regenerate byte-identically to their pre-refresh baselines and to the second fresh generation. The semantic groups/18 attributes remain equivalent; only Weaver's registry provenance changes shape. Read source hash files and native Weaver checks as proof.

The root codegen refresh also changes ignored derived interop bindings under the new generators; they stabilize after regeneration and no tracked artifact outside telemetry changes. The final lead full gate passes all33 steps with the compatibility repair already committed as the producing parent. The recorded full output ran on the same combined source content before source commits; tests-only fixture cleanup is separately verified. Earlier absent-PG or ignored-cache-root failures are excluded from acceptance passes.

A1 moved the worktree out of the shipped preset's ignored cache root. No Biome configuration or unrelated source was changed; fresh pinned Biome2.5.14 workspace lint passes. Direct changeset coverage includes telemetry-semconv, with memory/runtime/SDK coverage retained from earlier milestones. M1 evidence metadata receives only the independently requested pinned original-test recheck.

Review correction at producing tree b318af2c8282d4cb0f0ab74dcd9a28cb3a8850ca: the original compound-command capture redirected only its final condition, leaving the server log empty. The lead grouped the entire command, reran SHOW server_version and SHOW server_version_num, and captured17.11/170011 with exit0. server-proof-recheck.json retains the exact command and status. This is a durable proof correction, with no environment or product-source change.

Exact native outputs and source patches are retained in transcripts.tar.gz. Extract it in disposable scratch; transcript-index.json pins every member by SHA-256 and byte count. Historical paths remain labeled recorded facts; repeat the prescribed commands in the current repository environment.
