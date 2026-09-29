# KRT-BN006 Dependabot support evidence

Fetched: 2026-09-29T10:32:59Z

Primary source: GitHub Docs, “Dependabot options reference”

- Canonical URL: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- Immutable source: https://github.com/github/docs/blob/f4e8afc6979acd8de6b5da035066281b9a5f4025/content/code-security/reference/supply-chain-security/dependabot-options-reference.md
- Exact source URL: https://raw.githubusercontent.com/github/docs/f4e8afc6979acd8de6b5da035066281b9a5f4025/content/code-security/reference/supply-chain-security/dependabot-options-reference.md
- Upstream commit: `f4e8afc6979acd8de6b5da035066281b9a5f4025`
- Full fetched source SHA-256: `eb6fdf35cd63fe32a4cda8f12d310099ecf9293a779318929120e6c48a6fa700`
- Retained exact excerpts: `dependabot-options-reference.excerpt.md` (9,483 bytes; SHA-256 `b168dcd7886e2d78a6b4b4c9ab8d3c4dc80cf645a8e01d91d4da21f369f8845c`). It contains individually delimited upstream ranges for required keys (`version: 2`, `directory`, and `schedule.interval`), groups, group patterns and update types, ignore rules, and package ecosystem values including `bun`, `cargo`, and `github-actions`. It is not represented as a complete source file.

License and provenance:

- SPDX expression for this retained documentation content: `CC-BY-4.0`.
- The pinned GitHub Docs README declares Creative Commons Attribution 4.0 for documentation and content in its `assets`, `content`, and `data` folders; the separately declared MIT license applies to code. This retained source is a file in `content/`, so the CC-BY-4.0 declaration applies.
- License text location: https://github.com/github/docs/blob/f4e8afc6979acd8de6b5da035066281b9a5f4025/LICENSE (exact source URL: https://raw.githubusercontent.com/github/docs/f4e8afc6979acd8de6b5da035066281b9a5f4025/LICENSE; SHA-256 `12d3a82a7d1378e6f597ec23d63a081aeb6ec4bc8de2a76ee9dc96c34c6d7a1b`).
- License declaration location: https://github.com/github/docs/blob/f4e8afc6979acd8de6b5da035066281b9a5f4025/README.md (SHA-256 `1adc06cb1008208c356da0982fc8b81ee6d006695aae02f8464370ad87d78a5d`).
- Retained license excerpts: `github-docs-license.excerpt.md` (861 bytes; SHA-256 `ca79232b792b84afaa617ce97287424edafaa818fe33e7d38156ea8c82828abc`). It contains separately marked exact ranges from the README licensing declaration and the LICENSE title.

The extracted passages establish `version: 2`, `directory`, and weekly `schedule.interval` as supported required configuration; `bun` as the YAML package ecosystem for Bun `>=v1.1.39`; `cargo` and `github-actions` as valid ecosystem values; group `patterns` support for `*`; group update types `minor` and `patch`; and ignore update type `version-update:semver-major`. The project profile reports Bun `1.3.10`, meeting the documented Bun threshold.

Configuration contract:

- Input parser: installed `yaml` `2.9.0`.
- `dependabot-contract-probe.mjs` parses YAML with duplicate-key errors enabled and requires one exact JavaScript object: version `2`; exactly `bun`, `cargo`, and `github-actions`; root directories; weekly schedules; one `minor-and-patch` group with `patterns: ["*"]` and `update-types: ["minor", "patch"]`; and one wildcard major ignore per ecosystem. Its deep equality assertion also proves `gomod`, `pip`, and `pub` are absent.
- No `dependency-type` or multi-ecosystem group is configured.

The lead commands are recorded in command.txt. The contract probe output and
support-retrieval transcript are complete; repository-check-summary.log retains
only the exact final phase summary from the lead's green gate. The complete
gate log remains a historical temporary artifact, as that summary records.
biome-dependabot.log records non-applicability: the repository's Biome
configuration ignores .github. It does not claim formatting coverage.
