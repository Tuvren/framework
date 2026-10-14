# Historical suppression measurements

`suppressions.json`, `metadata.json`, and `assertions.json` preserve the
retained-checker measurement and its controls. All 12 original identities
retain their original reasons and historical retained states. The readable
[suppression projection](suppression-projection.json) copies their planned
dispositions. Omitted final fields were absent at this measurement; they are
not false or null results. BX004 records final admission. The historically
firing `eslint/require-await` issue was fixed in M28 without a counterpart.

Packaging snapshot: `d1f8d7d4a0775c665b33cc5466fd69673b86115b`.
The preserved outer manifest names producing commit `5b7fff3b19b97ccdae30159a152633d573be9fb5`.
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
mkdir -p .claude/execute-wave/proof-extract/KRT-BX002
tar -xzf .constitution/evidence/KRT-BX002/proof.tar.gz \
  -C .claude/execute-wave/proof-extract/KRT-BX002
```

Never extract into the repository root or overwrite the outer manifest.
For example, the extracted original manifest is at
`.claude/execute-wave/proof-extract/KRT-BX002/.constitution/evidence/KRT-BX002/manifest.yaml`.
Compare extracted bytes with the index before inspecting or replaying them.
