# TypeScript Binding Appendix

`@tuvren/core/runner` is the TypeScript binding projection for the neutral
execution-model contract (the `driver` binding section of `tuvren.shared.core`
per ADR-037; the deprecated `@tuvren/driver-api` re-export shim was retired at
87-M6.1c). Concrete driver factories, callable hooks,
`Promise`, and `AbortSignal` are binding conveniences only. ReAct-specific
behavior is covered by the separate `tuvren.framework.react-driver` packet.

Portable packet artifacts type the serializable driver payloads, but fields
whose live TypeScript shape includes callable state such as `AgentConfig` and
`HandoffContextPlan` remain packet-level opaque metadata and are refined by the
binding contract plus its runtime validators.
