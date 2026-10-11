# Suppression measurement at M3

The ledger records every baseline identity and original reason at commit
`34b16bd3c2ec26cfc1a8f24cb787ece14f442fee`. All six directives remain needed by
Biome. Oxlint's enabled barrel rule reports no matching diagnostic, so none
justifies a native suppression. Counts describe this measurement, not a quota.

`reports.tar.gz` preserves the raw reports named by the ledger. The archive index
records each member's SHA-256 and byte count. `manifest.yaml` covers the readable
artifacts, index and archive. The earlier lint failure is historical evidence;
the repaired commit's complete lint gate passes.

For exact replay, use a clean worktree at the recorded measurement commit with
the pinned dependencies installed. Copy `probe.ts` and `suppressions.json` to an
external directory. Run from that worktree's root:

```sh
direnv exec . bun EXTERNAL_DIRECTORY/probe.ts . EXTERNAL_DIRECTORY/results EXTERNAL_DIRECTORY/suppressions.json
```

The output directory must remain outside the repository. The probe compares the
complete identity set and reasons, exercises missing-entry and altered-reason
controls, checks byte-identical external mirrors under the exact Biome policy,
and runs retained lint, repository typecheck and direct changeset coverage.
It rejects a saved ledger measured at another commit.

To inspect archived reports, extract them into an external directory:

```sh
tar -xzf .constitution/evidence/KRT-BQ002/reports.tar.gz -C EXTERNAL_DIRECTORY
```

Preserve this initial measurement when recording later fixes or native admission.
Later disposition evidence must retain the same baseline identities and reasons
and cite its own fresh diagnostics and producing commit.
