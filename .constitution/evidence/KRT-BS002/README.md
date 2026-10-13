# Suppression measurement at M3

This evidence measures KRT-BS002 at commit
`9c4ec5f3951620c3e39cd06af3c83e24b4f18953`, against baseline
`6597a27223bf70956cf1b48a9661d21ff1d32bad`.
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

For replay, use a worktree at the measurement commit with its pinned dependencies
installed. Copy `probe.ts` and `suppressions.json` to an external directory.
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
the required gates. A supplied ledger must match the same measurement commit
and fresh dispositions. The replay was verified with a separate output directory.

Rule interpretation follows the [Biome barrel rule documentation](https://biomejs.dev/linter/rules/no-barrel-file/)
and [Oxlint barrel rule documentation](https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-barrel-file.html).
The installed registry and effective configuration independently confirm the
enabled native candidate. Its documented export-star threshold does not make
the unrelated JSDoc diagnostics a suppression counterpart.
