# Historical declaration-order measurements

`ordering.json`, `m24-cohort.json`, and `m25-cohort.json` preserve the
declaration-order phase and its behavior checks. Their source snapshots
precede native admission and later review fixes. BX004 covers final bytes.

Packaging snapshot: `d1f8d7d4a0775c665b33cc5466fd69673b86115b`.
The preserved outer manifest names producing commit `47a23bd0960de54bee486a1a125a42f13a1d2ad0`.
That value and the archived command/date remain historical provenance.
A measurement with `working_tree_candidate: true` means the named parent
plus the tested candidate, identified by its recorded patches or hashes.
Use each member's own source state to replay historical commands.

The archive contains all 4 original files, including the byte-identical
`manifest.yaml`. The [proof index](proof-index.json) records repository-root
member names, original roles, SHA-256 digests, and byte counts. References
to removed JSON or patch paths in historical members resolve to archive
members. Existing raw-log and source hashes remain unchanged inside them.

From the repository root, extract into a separate ignored directory:

```sh
mkdir -p .claude/execute-wave/proof-extract/KRT-BX003
tar -xzf .constitution/evidence/KRT-BX003/proof.tar.gz \
  -C .claude/execute-wave/proof-extract/KRT-BX003
```

Never extract into the repository root or overwrite the outer manifest.
For example, the extracted original manifest is at
`.claude/execute-wave/proof-extract/KRT-BX003/.constitution/evidence/KRT-BX003/manifest.yaml`.
Compare extracted bytes with the index before inspecting or replaying them.
