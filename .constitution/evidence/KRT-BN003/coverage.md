# Changeset presence proof

The committed fixture suite is the repeatable check path: `bun test tools/scripts/changeset-check.test.ts`. Twenty isolated Git/workspace tests exercise missing/direct/unrelated intent, unchanged versus updated existing notes, private and root exemptions, actual Changesets2.31 fixed/private output, invalid bases, staged/unstaged/untracked changes, generated release replay, edits before/after versioning, updated base-pending snapshots, and exact PR-base CI wiring.

Generated release proof replays the installed CLI in a disposable worktree and compares public manifests/changelogs. It accepts a release-only delta and rejects public source or unrelated manifest edits. Native Changesets release propagation is not direct package coverage. Temporary worktrees are cleaned. Native parser alignment covers unknown workspace entries, malformed closing delimiters, and supported CRLF/trailing whitespace; each claimed Git state has an actual mutation and assertion. A native-valid none entry reports no version bump and cannot cover a changed public package.

The 20-case count describes this committed corpus, not a future pass threshold. The checker is a repository release-policy command; it introduces no cross-language runtime authority or product API change.

M3c models the actual repository's Bun lockfile discovery signal in each
synthetic workspace. The empty fixture marker is input to native package
discovery, not a dependency lock or a versioning oracle. All twenty assertions
and scenarios remain unchanged and pass on the retained CLI2.31 baseline.
The prospective CLI3 probe separately verifies that same corpus before adoption.
