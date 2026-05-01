# TypeScript Adapter Binding

The TypeScript binding projects `../protocol.schema.json` into TypeScript
without making TypeScript the semantic authority. Shared code in
`../index.ts` owns the protocol interfaces and runtime outcome guard.

```ts
export interface ImplementationAdapter {
  initialize(packetId: string, planVersion: string): Promise<AdapterCapabilities>;
  shutdown(): Promise<void>;
  createInstance?(input: unknown): Promise<unknown>;
  destroyInstance?(instance: unknown): Promise<void>;
  dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown
  ): Promise<OperationOutcome>;
  events(
    operation: string,
    input: unknown,
    controls: AdapterControls,
    instance?: unknown
  ): AsyncIterable<unknown>;
  inspectState?(query: unknown, instance?: unknown): Promise<unknown | null>;
}
```

`AbortSignal`, `Promise`, and `AsyncIterable` are TypeScript binding details.
Neutral controls are still the schema-owned `cancel`, `cancelAfterEvent`, and
`deadlineMs` fields; adapters may bridge those controls to `AbortSignal`
internally. Conformance plans name neutral operations, scenario inputs, expected
evidence fields, and assertion kinds.

Reference host helper:
`tools/conformance/adapter-protocol/stdio-host.ts`.
