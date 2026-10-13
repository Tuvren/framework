# Suppression measurement at M3

This evidence measures KRT-BS002 in the working tree based on commit
`f391ff64d1da4878bb73dcafda9f4c17a87d7474`, against baseline
`6597a27223bf70956cf1b48a9661d21ff1d32bad`.
The corrected evidence probe is assembled in the repository during capture.
`inventory.json` records the exact owned product hashes and initial Git status.
Both original barrel directives remain needed by Biome, with their original
reasons unchanged. Oxlint's enabled barrel rule reports no equivalent diagnostic.
The ledger therefore plans removal only at atomic admission, after fresh proof.
It authorizes no native suppression and no early deletion.

The retained Biome check, repository typecheck, full lint gate, and direct patch
changeset gate pass. Oxlint reports 451 diagnostics: 176 in gRPC, 240 in testkit,
and 35 in certification. These are measured baseline counts, not completion
quotas or a claim that the packages pass native lint. All five roots retain
Biome ownership. The probe leaves every owned file and Git status unchanged.

`reports.tar.gz` preserves the complete raw reports. Oxlint diagnostics use
`--format=unix`; the JSON files wrap the raw stdout and stderr without truncation.
Each report records its command, working directory, exit status, and stream
SHA-256 digests. `report-index.json` records archive member digests and byte sizes.
The ledger links those reports. `assertions.json` records acceptance results.

For replay, use a worktree with product hashes matching `inventory.json`, pinned
dependencies installed, and the corrected probe present at its evidence path.
Copy `probe.ts` and `suppressions.json` to an external directory.
Set `REPOSITORY` to the absolute worktree path, `EVIDENCE_DIRECTORY` to that
external directory, and `OUTPUT_DIRECTORY` to a separate external output path.
Set `ENVIRONMENT_REPOSITORY` to the repository whose approved direnv environment
provides the tools. Launch from the measurement worktree:

```sh
cd "$REPOSITORY"
direnv exec "$ENVIRONMENT_REPOSITORY" bun "$EVIDENCE_DIRECTORY/probe.ts" \
    "$REPOSITORY" "$OUTPUT_DIRECTORY" \
    6597a27223bf70956cf1b48a9661d21ff1d32bad \
    "$EVIDENCE_DIRECTORY/suppressions.json"
```

The probe checks the exact identity set and original reasons, then rejects
missing-entry and altered-reason controls. It compares suppressed and
unsuppressed external copies under the retained policy. Only VCS discovery
changes for those copies; rule settings remain unchanged. Product source is
never edited. Combined and per-root Unix reports must contain all diagnostic
lines and agree exactly. The probe also verifies retained coverage and runs
the required gates. A supplied ledger must match the same measurement HEAD
and fresh dispositions.
To verify an assembled later commit with unchanged product bytes, omit the optional
ledger argument; the probe emits a fresh ledger for that HEAD. The corrected probe
passed a separate replay including the full lint gate after repository assembly.

Rule interpretation is pinned to the installed releases' upstream commits:
[Biome 2.5.14](https://github.com/biomejs/biome/blob/af4365d2b80177d0e0434c0ed4fd2c9171afc56c/crates/biome_js_analyze/src/lint/performance/no_barrel_file.rs)
and [Oxlint 1.86.0](https://github.com/oxc-project/oxc/blob/2ae2939bb2fd98796393658b21556b2a2467e047/crates/oxc_linter/src/rules/oxc/no_barrel_file.rs).
The probe fixes subprocess locale with `LC_ALL=C` for parsed output.
The release tags resolve to those commits. The installed registry, effective
configuration, and fresh diagnostics supply the measured counterpart proof.
Oxlint's source sets a default threshold of 100 and examines export-star
module requests; unrelated JSDoc diagnostics are not barrel counterparts.
