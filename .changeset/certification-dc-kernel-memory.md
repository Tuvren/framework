---
"@tuvren/backend-memory": minor
"@tuvren/kernel-runtime": patch
---

Stop advertising mid-commit fault injection and remove the memory backend's midCommit test hook because it cannot expose a genuine storage boundary. This changes untagged exported behavior and requires a minor release under ADR-0069 decision 3.

Align kernel runtime behavior with the shared syscall certification plans and verify memory-backed run, lease, recovery, reclamation, and scope isolation behavior through catalogued operations.
