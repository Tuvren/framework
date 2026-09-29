---
id: ADR-0074
status: accepted
date: 2026-09-29
certainty: settled
evidence:
  kind: ruling
  ref: .constitution/reports/2026-09-29-interview-tech-spec.md
  date: 2026-09-29
  note: "Rulings 13 and 14 and the closure of OD-04; failure causes measured in .constitution/evidence/KRT-BN001/."
---
### ADR-0074 The devenv Refresh Lands with the Weaver Manifest Migration and Bun 1.4

- **Status:** accepted. Refines the toolchain posture recorded after KRT-BN001 and supersedes the deferral of the Bun 1.4.2 target.
- **Context:** KRT-BN001 attempted the Bun 1.4.2 target twice and failed for two independent reasons. A full nixpkgs refresh moved Weaver, Postgres and Bun together, and the newer Weaver rejected the deprecated `registry_manifest.yaml` fields (`semconv_version` and `schema_base_url`) in the telemetry codegen freshness gate. A Bun-only candidate failed 3 of 77 memory-backend tests. The devenv shell provides Weaver 0.21.2, PostgreSQL 17.9 and Bun 1.3.10. Weaver 0.22.1 introduced `schema_url` and `manifest.yaml`; the old fields still parse with a warning, so the migration cannot land before the refresh because Weaver 0.21.2 does not read `schema_url`. Bun 1.4.0 deliberately made `node:assert` compare own-enumerable properties on typed arrays like Node (Bun pull request 34660, merged 2026-08-07), and `cbor-x` sets `dataView` as an own property on the buffer it decodes, so the memory backend's aliasing of stored buffers is exposed.
- **Decision:**
  1. **Refresh the whole devenv nixpkgs pin.** The refresh and the Weaver manifest migration (rename `registry_manifest.yaml` to `manifest.yaml` and replace `schema_base_url` plus `semconv_version` with one `schema_url`) land in one change, together with the regeneration of the four telemetry artifacts that the newer Weaver's output changes.
  2. **Keep the PostgreSQL major guard.** `pkgs.postgresql_17` stays explicit, so a refresh may move the minor version but never the major. The 17.9 to 17.11 movement is accepted.
  3. **Move Bun to the latest 1.4.x** (1.4.2 at the time of this record) after the refresh, as `pkgs.bun` from the refreshed pin. `packageManager` is aligned to the installed version, and the Dependabot ignore for `@types/bun`, `bun-types` and `bun` at 1.4.0 and above is removed when the upgrade lands.
  4. **Fix the memory backend, not the tests.** The memory backend copies buffers on read and write so stored records are never aliased by a decoder. The tests are unchanged. The `bun test` isolation behavior in 1.4 is reviewed for cross-file state across the 204 test files, and the 1.4.0 changes to `trustedDependencies` scoping and registry credential scoping are checked against `package.json` and CI.
  5. **Update the stack pin.** The `bun` record in `stack.yaml` moves from assumed to settled when the lockfile and devenv agree.
- **Alternatives considered:**
  - Pin Bun alone through a second nixpkgs input, leaving the rest of the pin alone. Rejected by the owner in favor of a full refresh at a safe time, made safe by landing the manifest migration atomically and keeping the Postgres major pinned.
  - Migrate the Weaver manifest first. Rejected: Weaver 0.21.2 does not read `schema_url`.
  - Change the tests to strip `dataView` before comparing. Rejected: the aliasing is a real bug and the strict comparison is Node-compatible behavior.
  - No second design was requested. The owner ruled the choices in the session.
- **Consequences:** Assumed until observed. The refresh can change other tools that share the pin (`buf`, `protobuf`, `postgresql`), so the full verification lane must pass on the refreshed pin before Bun moves. The unverified points are whether `bun test --isolate` is the default in 1.4 (two reads of the release notes conflicted) and whether the text `bun.lock` format changes. ADR-0072 depends on Bun 1.4.1 or later for `bun install --offline`.
