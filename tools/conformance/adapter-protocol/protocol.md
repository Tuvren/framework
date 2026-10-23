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

## Version 0.2.0

Version 0.2.0 keeps every 0.1.0 method and adds operation handles, live subscriptions, storage attachment, fault arming, and clock control (ADR-0076, ADR-0077). A manifest declares the version in `protocol.version`; the schemas accept `0.1.0` and `0.2.0`.

```text
initialize(...) -> AdapterCapabilities & {
  protocolVersion?, profiles?: string[], storageKinds?: StorageKind[]
}
createInstance({ input, storageRef?, scope?, clock? }) -> InstanceHandle
openInstance({ storageRef, scope? }) -> InstanceHandle
startOperation({ operation, arguments, instance }) -> { operationHandle }
awaitOperation({ operationHandle }) -> OperationOutcome
cancelOperation({ operationHandle, reason })
subscribe({ instance, channel, operationHandle? }) -> { subscription }
pull({ subscription, credit })
armFault({ instance, point, selector, occurrence, mode: "throw" | "block" }) -> { token }
setClock({ instance, domain: "backend" | "worker", nowMs })

notification event({ subscription, sequence, event })
notification eventsEnd({ subscription, terminal })
notification faultReached({ token, processEpoch, phase })

StorageKind ::= "none" | "sqlite-directory" | "postgres-database"
```

Handles (`operationHandle`, `subscription`, `token`, `storageRef`) are opaque strings. Hosts keep processing requests while started operations run. A `throw` fault outcome carries the arming `token`. The adapter manifest adds `storage` (one `StorageKind`), `profiles[]`, and an `executable` the supervisor launches directly. The harness owns storage, clocks, process lifecycle, scheduling, and every verdict; see `.constitution/tech-spec/contracts/conformance-certification.md`.

Adapter stdout must contain protocol frames only. Diagnostics belong on stderr
or in `AdapterObservation.diagnostics`. JSON-RPC failures, malformed frames,
process exits, timeouts, and adapter protocol errors are runner-owned adapter
failures; adapters must not map those failures into `$.result.error`.

A long-lived adapter must emit exactly one response frame per request even
when its own response value fails to serialize (a non-JSON-encodable
projection, NaN, and similar): rather than writing no frame — which would
hang the runner on that request id — the adapter falls back to a minimal
JSON-RPC error frame whose ErrorEnvelope code is
`adapter_response_serialization_failed`, and logs details to stderr.

Adapters bridge to language-native functions, promises, async iterables,
tokens, byte buffers, and errors internally. Those binding shapes belong only in
binding appendices or adapter-local source. Adapters do not receive `checkId`,
do not expose `emitEvidence`, and do not decide pass/fail.
