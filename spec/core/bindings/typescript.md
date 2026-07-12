# TypeScript Binding Appendix

`@tuvren/core` (with its subpath exports) is the TypeScript binding
projection for `tuvren.shared.core-types`; the historical `@tuvren/core-types`
shim completed its deprecation window and was removed at KRT-BM006.
TypeScript classes, predicates, `unknown`, and language-native `Error`
inheritance are binding conveniences only.

Where the packet carries portable file/media payloads, TypeScript `Uint8Array`
values are projected as `uint8[]` JSON arrays in emitted artifacts.

## Telemetry funnel-routing (ADR-058)

The `telemetry` binding section projects the construction-time funnel-routing
contract (KRT-BJ004) to TypeScript as `@tuvren/core/telemetry` interfaces:
`TelemetryDestination` (a durable delivery target with `deliver(batch)`, an
optional `buffering` policy, and an optional `onOperationalSignal` channel),
`TelemetryRoute` (a sink + destination pairing), `TelemetryOperationalSignal` /
`TelemetryOperationalSignalKind`, `TelemetryBufferingPolicy`, and the
`TelemetryRouting` union that widens the `createTuvren` `telemetry` option. These
are contract declarations only. The one-directional failure-isolation invariant
— a `deliver`/sink throw is caught, converted to an operational signal, and can
never fail, block, or delay a content-funnel commit or kernel checkpoint — is
realized at the `@tuvren/runtime` telemetry boundary, not in this projection.
