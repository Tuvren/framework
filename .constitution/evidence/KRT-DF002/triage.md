# KRT-DF002 triage

Adapted from the prior DF001–DF002 triage for the state at commit 44e9481.

The syscall reopen probe uses the harness-provisioned storage reference, observes a new PID and epoch after SIGKILL and respawn, and reads previously written state. The probe observes no child processes in either supervised adapter epoch.

The ticket's unqualified acceptance that no adapter code spawns its own kernel processes is not met: the intentionally retained legacy SQLite restart-recovery path calls `runRestartRecoveryPhase` for its write and read phases, and that helper spawns the SQLite kernel scenario. See `typescript/kernel/conformance-adapter/src/host-restart-recovery-scenarios.ts` and `typescript/kernel/conformance-adapter/src/host-support.ts`. The ticket description separately permits this legacy child process until DJ retires that plan; the acceptance clause does not state that exception.

The legacy `invalid-staged-result-reexecutes` check asserts retained pending work and the last completed step, but does not demonstrate invalidity or actual reexecution. The obligation map describes only the behavior observed. The former gap for the `processExit` assertion was addressed by the process-crash work; current tests exercise that assertion.
