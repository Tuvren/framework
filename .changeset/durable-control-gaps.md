---
"@tuvren/backend-memory": minor
---

Remove the symbol-keyed fault control from constructed memory backends. Fault injection uses the testkit transaction seam for before-commit rollback and after-commit recovery checks.
