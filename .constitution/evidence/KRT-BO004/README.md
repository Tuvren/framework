# KRT-BO004 measured isolation, dependency trust and registry-auth scope

Producing code commit3ec59ce3874d11f8bf3107b5139ac629e14127ba. This is evidence-only: no product/config/assertion changed. At this head the tracked inventory is204 (baseline201 plus3authorized regressions), comprising179Bun project files,9tools files and16SQLite Node files.

Independent lead replay executed29Bun projects in ordinary and isolated modes, each1596passed cases across179files. Complete outer-file JUnit outcomes agree for every file;9tools files add107passed cases in bothmodes;16SQLite files add115passed cases under the declared Node lane. All204files have a measured check. Ordinary Bun shares module/global state; explicit isolate resets it. Outcome equivalence is measured, not a claim that no cross-file interaction can ever exist.

Eight local file/link trust scenarios and14loopback registry/auth/TLS scenarios meet explicit assertions: blockeduntrusted scripts, explicittrustallows, defaulttrustednameonlyregistry; authorized origin receives synthetic sentinel, other host/origin/port or HTTPSdowngrade neverdoes; untrusted CA fails; no sentinel leaks in output. No real credential file/value or publishing was used. Scratch listeners are stopped.

The worker's first parser overwrote outerfile counts with nested describes, giving1094; the corrected lead parser retains completefile totals1596, matching nativeBun counts. The first lead wrapper omitted a copied project-list input and sentinel markerdirectory, so it cannot be considered a project/default-isolation acceptance run; explicit subsequent rechecks supplied29project/179file/1596case and sentinel state assertions. All final tables/assertions and full33-step gate pass. Invalid exploratory runs are not promoted as passes.

Probe scripts inside the archive are historical exact tools with parameterized scratch entrypoints plus recorded paths. To rerun, relocate their recorded code/root constants to disposable scratch/current checkout before invoking. Keep synthetic auth configs/CA keys outside the repository. No fake token, key or client credential config is included here beyond the intentionally synthetic sentinel literal used by probe code.

Pre-existing coverage gap:8tools testfiles lack Nx/verify ownership (changeset test has CI). They were directly checked here and are routed to the owning tooling stage without widening this ticket to change verify scripts. Root bun test is not a canonical lane: it includes Node-onlySQLite and hostcwd-dependent CLI tests; those failures are explicitly excluded from pass claims, with canonical lanes proven.

Exact native outputs and source patches are retained in transcripts.tar.gz. Extract it in disposable scratch; transcript-index.json pins every member by SHA-256 and byte count. Historical paths remain labeled recorded facts; repeat the prescribed commands in the current repository environment.
