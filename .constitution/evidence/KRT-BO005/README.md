# KRT-BO005: measured physical stack pins

The specification patch settles Bun 1.4.2 using the installed binary, packageManager and the already retained actual frozen-install/isolation proofs under KRT-BO003 and KRT-BO004. The complete patch is pinned here against parent 2e32938; the proof applies to that parent plus the patch, not to the bare parent. The specification is committed separately from implementation code and this evidence/status bookkeeping.

The eight shared Nix tool records use revision c2f38fe7f9e04d9aadd354d380f2bd40531d9737. Native probes establish Buf 1.72.0, protobuf 36.1, protoc-gen-es 2.12.0, Weaver 0.25.1, Go 1.26.7, Python 3.14.7, Dart 3.13.0, and PostgreSQL client/server 17.11. Bun keeps its existing SemVer convention so its record equals packageManager. The untouched Rust pin is 1.95.0. Node 24.20.0 is measured but has no existing bill-of-materials record.

The generated transport bindings use protoc-gen-es 2.12.0 and import the locked @bufbuild/protobuf runtime 2.11.0; those bindings are derived/ignored files, not a newly checked-in authority. M2 regeneration and the full gate exercise this pairing. The worker's supplementary frozen-install probes used --dry-run; the actual unchanged-lock installations are the earlier BO003 evidence. The lead checker independently probes all refreshed tools, the actual server, and every untouched stack record. Both final worker and lead full gates pass all 33 steps.

Older prose in guidelines and ADR-0073's planned Bazel Go/Python synchronization is routed to Stage 3/4 through closeout, outside this epic's patchable stack file. Future OXC/Bazel assumptions and aimock 1.15.1 remain untouched at this milestone. No semantic contract or compatibility boundary changed.

Exact native outputs and source patches are retained in transcripts.tar.gz. Extract it in disposable scratch; transcript-index.json pins every member by SHA-256 and byte count. Historical paths remain labeled recorded facts; repeat the prescribed commands in the current repository environment.
