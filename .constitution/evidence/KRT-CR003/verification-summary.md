# KRT-CR003 verification summary

Cold recovery now consumes a durable interrupted-batch plan before invoking the model. It dispatches only missing calls through the existing tool gateway, including `nonRetryable` calls, and retains the original `(turnId, callId)` idempotency identity. Completed calls do not dispatch, the original assistant message is not restaged, recovered and new results checkpoint together, and approval pause/resume uses the normal path.

Lead verification passed runtime typecheck, lint, 531 tests, and the `reference-host-headless-sqlite` live recipe. The proving-host scenario reported every reload/durability check true and the required evidence line is preserved in `live-probe.log`.

The first three broad attempts exposed only unchanged host-repl subprocess tests crossing their fixed five-second deadline under measured wave load. Read-only diagnosis confirmed no host source/target diff from master and standalone master/CR host suites both passed. The wave lead amended scheduling without changing tests, timeouts, assertions, selection, or cache policy. The full required gate then passed with the existing global lock plus `VERIFY_SERIAL=1 NX_PARALLEL=1`; host-repl passed 191/191 in 74.72 seconds.
