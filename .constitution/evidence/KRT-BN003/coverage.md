# Changeset presence proof

The committed fixture suite is the repeatable check path: `bun test tools/scripts/changeset-check.test.ts`. Sixteen isolated Git/workspace tests exercise missing/direct/unrelated intent, unchanged versus updated existing notes, private and root exemptions, actual Changesets2.31 fixed/private output, invalid bases, staged/unstaged/untracked changes, generated release replay, edits before/after versioning, updated base-pending snapshots, and exact PR-base CI wiring.

Generated release proof replays the installed CLI in a disposable worktree and compares public manifests/changelogs. It accepts a release-only delta and rejects public source or unrelated manifest edits. Native Changesets release propagation is not direct package coverage. Temporary worktrees are cleaned.

The 16-case count describes this committed corpus, not a future pass threshold. The checker is a repository release-policy command; it introduces no cross-language runtime authority or product API change.
