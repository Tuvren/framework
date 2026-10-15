# KRT-CR001 verification summary

The completed spike at `.constitution/spikes/SPK-KRT-CR001.md` records the measured stale-preemption recovery shape for the seven certified kernel implementations and the shared conformance rule that binds them.

- Successful stale preemption reactively checkpoints staged assistant and tool-result messages into committed history.
- The recovery head equals the Branch head and `uncommittedStagedResults` is empty on that path.
- Protocol-valid ordinary recovery may still expose uncommitted staged messages, so KRT-CR002 must normalize both durable shapes.
- Fulfillment is matched through decoded `ToolResultPart.callId`, never through the two implementation-specific task ID formats.
- The spike gives the exact cold-crash characterization sequence and assertions that KRT-CR002 will implement.

Lead verification ran `bun run check` under the wave's shared verification lock with the approved PostgreSQL connection. Every authority, freeze, conformance-plan, formatting, and affected-project gate passed. The initial sandboxed worker attempt could not create the Nx cache directory and produced no semantic result or generated change; the lead run is the acceptance result.

The spike also records one non-blocking, out-of-scope authority drift: `spec/kernel/authority-packet.json` still narrates the old `(runId, callId, fencingToken)` identity. EPIC-CR leaves that file untouched and routes it to its authority owner.
