# TypeScript Binding Appendix

`@tuvren/driver-api` is the TypeScript binding projection for
`tuvren.framework.driver-api`. Concrete driver factories, callable hooks,
`Promise`, and `AbortSignal` are binding conveniences only. ReAct-specific
behavior is covered by the separate `tuvren.framework.react-driver` packet.

Portable packet artifacts type the serializable driver payloads, but fields
whose live TypeScript shape includes callable state such as `AgentConfig` and
`HandoffContextPlan` remain packet-level opaque metadata and are refined by the
binding contract plus its runtime validators.
