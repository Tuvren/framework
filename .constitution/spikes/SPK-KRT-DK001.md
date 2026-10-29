# Spike report: KRT-DK001 portable certification core

## Effort budget

- **Budget:** 3 story points (the `Effort` of KRT-DK001)
- **Spent:** to be filled during execution

## Question

- **Owner:** KRT-DK001 (`.constitution/tasks/epics/EPIC-DK-portable-certification-core.yaml`)
- **Decision this spike must produce:** How does the full import closure of `tools/conformance/harness`, including plan compilation, certification assembly, conformance-contract and verification-logs, and the negative-control runner and claim coverage, split into a web-standard core and a Node driver? Do Ajv standalone validators reproduce runtime-compiled verdicts, and are generated outputs checked in or built? Does an in-process transport yield the same observations as stdio? Can AsyncLocalStorage be designed out of the testkit controls and the memory backend?

## Context and objective

- **Triggering upstream file or section:** `.constitution/tech-spec/adrs/ADR-0082-published-runtime-portable-backend-testkit.md` decisions 2 to 5 and 13; `.constitution/tech-spec/guidelines.md` section 5.11
- **Target:**
  - the module boundary across the full import closure between the core and the driver, including plan loading, negative controls, and certificate assembly;
  - the Node-only `kernel-mutants-storage.ts` and `kernel-conformance-fixtures.ts` testkit files;
  - validator verdict equivalence;
  - the generated-output strategy;
  - transport observation equality;
  - the AsyncLocalStorage residual.
- **Archetype / surface:** the conformance tooling behind the `@tuvren/backend-testkit` library surface

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
- **Tickets unblocked:** KRT-DK002, KRT-DK003, KRT-DK004
- **Register entry closed:** none
- **Tickets to add or split:** to be filled during execution
- **Spec edits required:** to be filled during execution
