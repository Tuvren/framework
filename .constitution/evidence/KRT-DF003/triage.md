# KRT-DF003 durable fault-point triage

Adapted from the prior DF003 triage for the state at commit ef893e1.

| Fault point | SQLite and PostgreSQL |
| --- | --- |
| `before-commit` | Supported; receipt and blocking occur after all checkpoint writes and before COMMIT (OD-25). |
| `after-turn-node-write-before-head` | Supported; receipt and blocking occur after the TurnNode write and before the head update. |
| `after-head-move-before-staging-clear` | Supported; receipt and blocking occur after the head update and before staging clear. |
| `after-commit-before-ack` | Supported; receipt and blocking occur after commit and before acknowledgement. |
| `commit-outcome-unknown` | Unsupported; neither backend exposes a verified submission-to-unknown-outcome receipt boundary. |

The pre-commit seam holds the transaction open; the post-commit seam necessarily runs after commit. Production construction cannot reach any commit-phase hook. At 44e9481 both public backend instances still exposed a legacy fault-injection symbol with `setFaultHooks`, and a probe observed its `beforeCommit` callback during `transact` without the durable test wrapper. Commit ef893e1 removed the symbol and its hook state from both backends; the receipt-and-block control and the legacy fault-injecting wrapper now share one testkit transaction seam, and per-backend tests show a publicly constructed instance offers no hook installation path while the seam still injects (public-construction-probe.json). The in-memory backend keeps its own symbol-keyed control; it is outside this ticket and is listed as a follow-up. The earlier PostgreSQL timestamp-order failures were addressed by the transaction-clock changes in b0a9552 and 79471ed; the focused and kernel lanes passed at ef893e1. OD-20 remains a proposed authority decision, not a newly settled rule.
