# KRT-DF005 triage

Adapted from the prior DF005 triage for the state at commit 44e9481. Earlier stopped-state notes and part A limitations describe historical work, not the present profile and certificate implementation.

The PostgreSQL shared-writer trace runs two supervised processes on one storage reference and requires both native entry receipts before release. The worker-clock expiry mutant is detected under skew. The shared-backend stale-head mutant can activate in one writer while the other reports no activation; the shared collect observes one result and one error, so neither release ordering detects a stale competing write. The current reasons are in `spec/conformance/kernel/kernel-shared-backend-undetected.json`. The expired-lease claim also has a recorded reason for lacking a designated detector.

The prior whole-outcome schema assertion convention was removed by 44e9481. The live-preemption trace now checks a catalogued adapter-error schema and an explicit error-kind observation. The earlier collect limitation for arbitrary native error details remains a proposed authority issue under OD-22.

SQLite claims persistent-reopen and process-crash; PostgreSQL also claims shared-backend. Certificates require a passing control run for the same profile and matching verifier digests. The disagreement comparison reports PostgreSQL-only applicability for the two writer orderings and server-clock check, rather than a disagreement on shared observations.
