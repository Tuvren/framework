# Host admission and review evidence

The current proof at the pinned snapshot is `readiness.json` together with
`pr-review-round3.json`. Round three supersedes earlier cursor-placement
and masked-handshake-test completion claims with the complete authority
carriage matrix and independent guard-removal controls. It records zero
native diagnostics across 57 code files and 144 release-tag associations:
112 firing tags in 38 authorized regions plus 32 inline tags. Packaging
changes no implementation.

All `m*.json` and `m*.patch` members, `suppressions.json`, and review rounds
one and two remain exact historical measurements, candidate patches, or
partial attempts. Their claims and formatting are preserved, including
claims superseded by round three. The [suppression projection](suppression-projection.json) preserves all 12 final dispositions and their
historical retained states. M28 fixed the actual `eslint/require-await`
issue; M36 removed its original directive at atomic admission. No native
legacy counterpart or early deletion is recorded. Active metadata
exceptions remain separate from original Biome counterparts.

Both current members name producing parent `d42986d152546b08d88ec28d4ef2ab45b621aee5`
with `working_tree_candidate: true`. This identifies that parent plus the
tested round-three candidate, subsequently committed as `9be1746`; it does
not claim the bare producing parent contains those candidate changes.

Packaging snapshot: `d1f8d7d4a0775c665b33cc5466fd69673b86115b`.
The preserved outer manifest names producing commit `d42986d152546b08d88ec28d4ef2ab45b621aee5`.
That value and the archived command/date remain historical provenance.
A measurement with `working_tree_candidate: true` means the named parent
plus the tested candidate, identified by its recorded patches or hashes.
Use each member's own source state to replay historical commands.

The archive contains all 25 original files, including the byte-identical
`manifest.yaml`. The [proof index](proof-index.json) records repository-root
member names, original roles, SHA-256 digests, and byte counts. References
to removed JSON or patch paths in historical members resolve to archive
members. Existing raw-log and source hashes remain unchanged inside them.

From the repository root, extract into a separate ignored directory:

```sh
mkdir -p .claude/execute-wave/proof-extract/KRT-BX004
tar -xzf .constitution/evidence/KRT-BX004/proof.tar.gz \
  -C .claude/execute-wave/proof-extract/KRT-BX004
```

Never extract into the repository root or overwrite the outer manifest.
For example, the extracted original manifest is at
`.claude/execute-wave/proof-extract/KRT-BX004/.constitution/evidence/KRT-BX004/manifest.yaml`.
Compare extracted bytes with the index before inspecting or replaying them.
