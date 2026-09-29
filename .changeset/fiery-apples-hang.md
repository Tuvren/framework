---
"@tuvren/core": patch
"@tuvren/runtime": patch
"@tuvren/backend-postgres": patch
---

Internal tooling update for the Biome 2.5 upgrade with no change to published behavior. `@tuvren/core` replaces six `biome-ignore` comments that Biome 2.5 reports as unused with plain comments, and the `@tuvren/runtime` and `@tuvren/backend-postgres` test suites pick up a lint fix and formatter output.
