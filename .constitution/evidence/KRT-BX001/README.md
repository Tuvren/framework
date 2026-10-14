# Safe-fix measurements

`safe-fixes.json` records historical M1–M5 safe-fix batches. It preserves
their diagnostic counts, changed files, and command outcomes. Later source
changes are covered by BX004; this snapshot does not describe final bytes.

Packaging snapshot: `d1f8d7d4a0775c665b33cc5466fd69673b86115b`.
The preserved outer manifest names producing commit `638d5b2bf2e2d9aba6c88100b9dc8124e9c99913`.
That value and the archived command/date remain historical provenance.
A measurement with `working_tree_candidate: true` means the named parent
plus the tested candidate, identified by its recorded patches or hashes.
Use each member's own source state to replay historical commands.

The archive contains all 2 original files, including the byte-identical
`manifest.yaml`. The [proof index](proof-index.json) records repository-root
member names, original roles, SHA-256 digests, and byte counts. References
to removed JSON or patch paths in historical members resolve to archive
members. Existing raw-log and source hashes remain unchanged inside them.

From the repository root, extract into a separate ignored directory:

```sh
mkdir -p .claude/execute-wave/proof-extract/KRT-BX001
tar -xzf .constitution/evidence/KRT-BX001/proof.tar.gz \
  -C .claude/execute-wave/proof-extract/KRT-BX001
```

Never extract into the repository root or overwrite the outer manifest.
For example, the extracted original manifest is at
`.claude/execute-wave/proof-extract/KRT-BX001/.constitution/evidence/KRT-BX001/manifest.yaml`.
Compare extracted bytes with the index before inspecting or replaying them.
