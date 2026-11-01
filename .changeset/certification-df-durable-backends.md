---
"@tuvren/kernel-protocol": patch
"@tuvren/kernel-testkit": patch
"@tuvren/backend-sqlite": patch
"@tuvren/backend-postgres": patch
---

Hold checkpoint before-commit faults after the final transactional write, scoped to the armed checkpoint transaction.

Recognize harness-owned process lifecycle controls and add a test-only durable checkpoint fault seam with correlated blocking receipts.

Remove the legacy symbol-keyed fault injection control from publicly constructed SQLite and PostgreSQL backends. Use the kernel testkit fault seam to inject commit faults.
