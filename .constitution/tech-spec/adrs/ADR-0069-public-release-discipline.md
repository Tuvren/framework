---
id: ADR-0069
status: accepted
date: 2026-09-29
certainty: settled
evidence:
  kind: ruling
  ref: "user ruling, planning session 2026-09-29"
  date: 2026-09-29
---
### ADR-0069 Public Release Discipline

- **Status:** accepted. Clarifies ADR-0054's stable-core SemVer policy for the 0.x period and governs the curated registry release path after ADR-0068 excludes the private session packages.
- **Context:** Only `0.1.0` of `@tuvren/*` was published on 2026-07-11; there are no git tags and `.changeset/` contains only `config.json` and `README.md`. The existing Changesets config fixes `@tuvren/*` into one version group with public access, while `privatePackages.version: true` also versions private packages. The repository already has `publish:preflight`, `publish:dry-run`, `publish:registry`, `release`, and `release-check` scripts, a manually dispatched `release.yml` with `dry_run`, npm token authentication, and provenance, plus `publish-registry.ts --verify-consumer <version>`. CI has jobs named `verify (primary semantic gate — bun run verify)` and `bazel (standing hermetic gate — rust/kernel build+test, TS shim build only)`. The public repository has no `master` branch protection or dependency-update configuration. `bun run publish:preflight` currently fails because public `@tuvren/stream-ws` depends on private session packages; ADR-0068 resolves the publication decision, subject to implementation and rechecking.
- **Decision:**
  1. **Require a changeset for public package changes.** Every change to a publishable `@tuvren/*` package ships with a changeset. The implementing epic creates `bun run changeset:check` and adds it to CI so a pull request that changes publishable package sources without a changeset fails. Private packages never require one. The expected starting point is `changeset status --since=<base>`, but its behavior with the fixed group and `privatePackages.version: true` is unverified; the implementing ticket must test it and settle the command's actual mechanism before enabling the gate. This mechanism is assumed, while the requirement is settled by the user ruling.
  2. **Keep public versions in lockstep.** The public `@tuvren/*` packages continue to release at one fixed version through the existing `.changeset/config.json` group. Versioning a private package under `privatePackages.version: true` does not make it publishable or subject to the changeset-presence gate.
  3. **Apply a precise 0.x SemVer rule.** While the major version is 0, a breaking change to an untagged stable or frozen export bumps the MINOR version; fixes and additive changes bump the PATCH version; `@experimental` exports may change in any release. The API freeze gate continues to enforce the stable snapshot. A 1.0 release is not scheduled. This clarifies the existing "semver-major" wording in `.constitution/tech-spec/guidelines.md` and `docs/guides/publishing-and-adopter-onboarding.md` §3 for the 0.x period; the implementing work must align the adopter guide.
  4. **Keep the real publish human-gated.** After a green `bun run publish:dry-run` and a green `release.yml` run with `dry_run: true`, the repository owner triggers `release.yml` with `dry_run: false`. The owner then runs `bun tools/scripts/publish-registry.ts --verify-consumer <version>`, creates git tag `v<version>`, and creates a GitHub Release whose body is the Changesets-generated changelog. Autonomous execution does not publish, tag, or create releases.
  5. **Assign repository settings to the owner.** The repository owner configures `master` branch protection to require the CI checks `verify (primary semantic gate — bun run verify)` and `bazel (standing hermetic gate — rust/kernel build+test, TS shim build only)`, and sets the GitHub repository description. Execution records these owner actions but does not apply the settings.
  6. **Automate bounded dependency updates.** Add `.github/dependabot.yml` with weekly minor and patch updates grouped per ecosystem for the root `bun` ecosystem, root `cargo` ecosystem, and `github-actions`. Defer Go, Python, and Dart ecosystems. Dependabot support for the `bun` ecosystem is assumed and must be verified by the implementing ticket before the configuration is treated as working.
- **Consequences:**
  - The first real publish waits for the curated dependency graph, changeset-presence gate, dry-run path, and owner-triggered release path to be verified. The existing `publish:preflight` failure is a current blocker, not a passed release gate.
  - Lockstep versioning gives adopters one public version to install, while private session packages remain internal under ADR-0068.
  - The 0.x MINOR rule makes stable breaking changes visible without implying a scheduled 1.0 release. Existing historical "semver-major" descriptions outside this ADR require implementation-time wording alignment when they describe the current 0.x package line.
  - The CI changeset gate and Dependabot `bun` configuration have explicit assumptions to settle in implementation; their behavior has not been proven in this repository.
