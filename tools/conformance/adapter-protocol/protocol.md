# Implementation Adapter Protocol

The Implementation Adapter Protocol is the neutral seam between a Generic
Conformance Runner and one implementation under test. The machine contract is
`protocol.schema.json`; this prose explains the contract but does not replace
it. Product semantics, operation inputs, and expected evidence come from the
authority packet and its conformance plans.

```text
initialize(packetId, planVersion) -> AdapterCapabilities
shutdown() -> void

dispatch(operation, input, controls) -> OperationOutcome
  OperationOutcome ::=
    | { kind: "result", value }
    | { kind: "error", error: ErrorEnvelope }

events(operation, input, controls) -> OrderedEventChannel
  OrderedEventChannel yields neutral JSON events in order.
  OrderedEventChannel terminates with completed, paused, or failed.
  OrderedEventChannel honors cancel.reason, cancelAfterEvent, and deadlineMs
  controls.

inspectState(query) -> StateView | null
emitEvidence(checkId, key, payload) -> void

ErrorEnvelope ::= { code: string, message: string, details?: JsonValue, cause?: ErrorEnvelope }
```

Adapters bridge to language-native functions, promises, async iterables,
tokens, byte buffers, and errors internally. Those binding shapes belong only in
declared binding appendices.
