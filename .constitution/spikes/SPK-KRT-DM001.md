# Spike report: KRT-DM001 codegen-free validator and single-transaction head rewind

## Effort budget

- **Budget:** 3 story points (the `Effort` of KRT-DM001)
- **Spent:** to be filled during execution

## Question

- **Owner:** KRT-DM001 (`.constitution/tasks/epics/EPIC-DM-tool-admission-integrity-and-codegen-free-validation.yaml`)
- **Decision this spike must produce:** Which interpreting JSON Schema validator replaces runtime Ajv in production, and with which `details` projection? Can existing kernel syscalls return the branch head and the turn head to the stable head in one kernel transaction after `run.complete(failed)`, or is a kernel operation needed?

## Context and objective

- **Triggering upstream file or section:** `.constitution/tech-spec/adrs/ADR-0083-codegen-free-schema-validation-and-clean-tool-admission-failure.md` decisions 1 and 4; `.constitution/tech-spec/stack.yaml` (`@cfworker/json-schema`)
- **Target:**
  - validation of drafts 7, 2019-09, and 2020-12 under `node --disallow-code-generation-from-strings`;
  - lineage consistency of the branch head and turn head after a hard iteration failure (kernel specification section 5.6).
- **Archetype / surface:** the library surface of `@tuvren/runtime`, `@tuvren/runner-react`, `@tuvren/mcp-client`, `@tuvren/provider-bridge-ai-sdk`, and `@tuvren/sdk`

## Codebase baseline

- **State today:** to be filled during execution
- **Discovered constraints:** to be filled during execution

## Options and trade-offs

- To be filled during execution

## Recommendation

- **Chosen option:** to be filled during execution
- **Why it fits:** to be filled during execution
- **Rejected options:** to be filled during execution

## Downstream impact

- **ADRs to write or update:** to be filled during execution
- **Tickets unblocked:** KRT-DM003, KRT-DM004
- **Register entry closed:** none
- **Tickets to add or split:** to be filled during execution
- **Spec edits required:** to be filled during execution
