# KRT-BO002 prerequisite compatibility proof

Producing parent: 8f2fbbc550f91a96d069e6541388062fa351ab1c. prerequisite-source.patch is the exact staged compatibility repair, new tests and cumulative changeset. migration-context.patch is the separately pending M2 environment/manifest/reader change used by the full gate. Apply both to the parent to reproduce the tested combined tree. This manifest does not claim the bare parent passed on refreshed tools.

Two independently reproduced causes account for nine Bun1.4 failures: strict object-prototype equality versus durable null-prototype JSON; SDK child paths replacing inherited source aliases and creating distinct core error constructors. The repair preserves content/structure/type comparison, original assertions, encodings and public constructor signatures. New tests ran red before changes (runtime5fail, SDK2fail), then green. Native skipPrototype controls pass on Bun1.4.2 and Node24.20.0, including changed-data negative controls.

Lead full verification passed all33 steps with restored run-owned PostgreSQL17.11; API freeze is unchanged. All original runtime/SDK test files compare unchanged against the producing parent. The final fixture-only cleanup removes newly introduced file-wide lint suppressions using explicit Promise-return stubs; all assertions are retained, and its final targeted tests/typecheck/lint pass. No full-gate pass is claimed for earlier absent-PG socket attempts.

The exact scope exception is user-authorized A2, recorded in the ticket deviations. No root Biome configuration, core source, PostgreSQL test or existing assertion was edited. Full verification uses the same pending M2 sources that will land atomically as the following migration commit.

Exact native outputs and source patches are retained in transcripts.tar.gz. Extract it in disposable scratch; transcript-index.json pins every member by SHA-256 and byte count. Historical paths remain labeled recorded facts; repeat the prescribed commands in the current repository environment.
