# Conformance Adapter Protocol

The Conformance Adapter Protocol is the neutral process seam between the shared
semantic runner and one implementation under test. The machine contracts are
`adapter-manifest.schema.json` and `protocol.schema.json`; this prose explains
the contract but does not replace it. Product semantics, operation inputs,
assertions, required evidence, check IDs, and pass/fail decisions come only from
authority packets and their conformance plans.

```text
JSON-RPC 2.0 request/response framing over line-delimited stdio. The `error`
member intentionally carries the Tuvren `ErrorEnvelope` shape below rather than
third-party JSON-RPC numeric error objects:

initialize({ packetId, planVersion }) -> AdapterCapabilities
createInstance({ input }) -> InstanceHandle | null
dispatch({ operation, input, controls, instance? }) -> OperationOutcome
events({ operation, input, controls, instance? }) -> JsonValue[]
inspectState({ query, instance? }) -> StateView | null
destroyInstance({ instance }) -> null
shutdown({}) -> null

AdapterCapabilities ::= {
  adapterId: string,
  capabilities: string[],
  packetId: string,
  planVersion: string
}

OperationOutcome ::=
  | { kind: "result", value: AdapterObservation }
  | { kind: "error", error: ErrorEnvelope }

AdapterObservation ::= {
  result?: JsonValue,
  events?: JsonValue[],
  state?: JsonValue,
  evidence?: JsonValue,
  diagnostics?: JsonValue
}

ErrorEnvelope ::= {
  code: string,
  message: string,
  details?: JsonValue,
  cause?: ErrorEnvelope
}
```

Adapter stdout must contain protocol frames only. Diagnostics belong on stderr
or in `AdapterObservation.diagnostics`. JSON-RPC failures, malformed frames,
process exits, timeouts, and adapter protocol errors are runner-owned adapter
failures; adapters must not map those failures into `$.result.error`.

Adapters bridge to language-native functions, promises, async iterables,
tokens, byte buffers, and errors internally. Those binding shapes belong only in
binding appendices or adapter-local source. Adapters do not receive `checkId`,
do not expose `emitEvidence`, and do not decide pass/fail.
