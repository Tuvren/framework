---
"@tuvren/kernel-runtime": patch
"@tuvren/backend-postgres": patch
"@tuvren/backend-sqlite": patch
---

Use the backend transaction clock for all kernel-stamped durable records on shared-clock backends, keeping lease rebasing and checkpoints in the same time domain. Embedded backends continue to use the injected kernel clock. Add PostgreSQL clock-skew and SQLite clock regression coverage.
