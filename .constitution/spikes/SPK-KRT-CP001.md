# Spike report: KRT-CP001 Affected-detection tool for the Bazel graph

## Effort budget

- **Budget:** 5 story points (the effort of ticket KRT-CP001); the research stops when the question is answered or the budget is spent, whichever comes first
- **Spent:** not started; filled by the worker during execution, in the same units, with one line on what was cut if the budget ran out

## Question

- **Owner:** KRT-CP001
- **Decision this spike must produce:** which affected-target tool, `bazel-diff` or `target-determinator`, the Bazel epics adopt for pull-request test selection, chosen on measured cost and correctness over the complete ported graph

## Context and objective

- **Triggering upstream file or section:** `.constitution/tech-spec/adrs/ADR-0071-bazel-is-the-single-task-graph-and-replaces-nx.md`, decision 6
- **Target:** exact inclusion of every affected failing target, reproducible selection, and the measured computation cost with a cold and a warm cache, over a corpus of real changed-file sets including toolchain and generated-input edits
- **Archetype / surface:** repository build and verification infrastructure (Library/SDK repository tooling)

## Codebase baseline

- **State today:** not yet measured. This file is a planning stub laid down so the ticket's spike id resolves; the worker replaces every section below with measurements.
- **Discovered constraints:** to be filled from direct inspection of the ported graph.

## Options and trade-offs

- Option A, `bazel-diff`: to be measured.
- Option B, `target-determinator`: to be measured.

## Recommendation

- **Chosen option:** to be decided by the measurements
- **Why it fits:** to be filled
- **Rejected options:** to be filled

## Downstream impact

- **ADRs to write or update:** none expected; a departure from the two approved candidates goes to a Stage 3 pass
- **Tickets unblocked:** KRT-CP002
- **Register entry closed:** none
- **Tickets to add or split:** to be filled if the answer changes scope of work
- **Spec edits required:** none expected
