# Certify the memory kernels

Run these commands from the repository root with the worktree environment loaded. The build targets produce the memory backend and the Rust adapter executable.

```sh
bun run nx run backend-memory:build
bun run nx run kernel-typescript-conformance-adapter:build
bun run nx run kernel-rust-certification:build
bun tools/conformance/meta-conformance/negative-controls.ts --port kernel --report-out .cache/kernel-memory-controls.json
bun tools/conformance/harness/run.ts --adapter typescript/kernel/conformance-adapter/adapter.json --control-report .cache/kernel-memory-controls.json --concurrency 4 --evidence-out .cache/typescript-memory-certificate.json
bun tools/conformance/harness/run.ts --adapter rust/kernel-conformance-adapter/adapter.json --control-report .cache/kernel-memory-controls.json --concurrency 4 --evidence-out .cache/rust-memory-certificate.json
```

The control report must contain a passing fleet run. Each certificate checks its implementation and adapter digests and every verifier digest against that report. A filtered or sharded run, a missing or changed control report, an incomplete profile, or changed inputs leave the result uncertified.

The Rust implementation digest hashes the supervised executable. The TypeScript digest covers the TypeScript workspace and installed dependency files, including built outputs. The verifier-authority digest covers the repository's authority files and schemas. These snapshots include additional files, so unrelated changes can require a fresh control run.

Run `bun run nx run kernel-rust-certification:certificate-contract` to exercise the control gate, certificate validation, digest mismatch handling, claim coverage, and disagreement report.
