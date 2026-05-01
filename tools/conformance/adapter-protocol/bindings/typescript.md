# TypeScript Adapter Binding

The TypeScript binding projects `../protocol.schema.json` into TypeScript
without making TypeScript the semantic authority. Shared code in
`../index.ts` owns the protocol interfaces and runtime outcome guard.

```ts
export interface ImplementationAdapter {
  initialize(packetId: string, planVersion: string): Promise<AdapterCapabilities>;
  shutdown(): Promise<void>;
  dispatch(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): Promise<OperationOutcome>;
  events(
    operation: string,
    input: unknown,
    controls: AdapterControls
  ): AsyncIterable<unknown>;
  inspectState?(query: unknown): Promise<unknown | null>;
  emitEvidence(checkId: string, key: string, payload: unknown): Promise<void>;
}
```

`AbortSignal`, `Promise`, and `AsyncIterable` are TypeScript binding details.
Neutral controls are still the schema-owned `cancel`, `cancelAfterEvent`, and
`deadlineMs` fields; adapters may bridge those controls to `AbortSignal`
internally. Conformance plans name neutral operations, scenario inputs, expected
evidence fields, and assertion kinds.

Reference scaffold:
`boundaries/framework/implementations/typescript/conformance-runner/src/adapter-scaffold.ts`.
