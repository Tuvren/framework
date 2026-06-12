# Epic T Kernel Interop Surface Inventory

This inventory closes `KRT-T001` by recording the first kernel-only transport
surface before the repository introduces Buf-governed `.proto` authority.

## Status

- Epic T is active in this change.
- The first interop seam is process-boundary gRPC/Protobuf around the kernel.
- FFI, Rust implementation, TypeScript transport clients, and framework-owned
  execution controls remain outside this epic.

## Included Kernel Surface

The initial transport mirrors the current `RuntimeKernel` groups used by the
TypeScript framework:

- `store`: put, get, has
- `schema`: register, get
- `tree`: create, incorporate, diff, resolve, manifest
- `node`: get, walkBack
- `thread`: create, get
- `branch`: create, get, setHead, list
- `staging`: stage, current
- `run`: create, beginStep, completeStep, complete, recover
- `turn`: create, get, updateHead
- `verdicts`: compose

This is intentionally narrower than the full framework API. It is the kernel
subsystem contract the framework can call remotely later, not a remote
`TuvrenRuntime`.

## Transport Payload Rules

- Hashes, ids, object types, task ids, schema ids, and paths travel as strings.
- Opaque stored objects travel as `bytes`, with optional media type only at
  store boundaries.
- `KernelRecord`, `KernelObject`, verdict metadata, observe annotations,
  observe signals, interrupt payloads, and similarly flexible payloads travel as
  deterministic kernel CBOR bytes.
- `PathValue` travels as an explicit `oneof` envelope so `null`, single hashes,
  and ordered hash arrays are not confused across languages.
- Verdicts and staged-result outcomes also use `oneof` transport shapes so the
  first baseline preserves the TypeScript discriminated-union invariants rather
  than depending on every implementation to reject mixed optional fields.
- `node.walkBack` is the only server-streaming RPC in the initial surface; all
  other RPCs are unary.

## Event And Error Boundaries

- Framework events remain framework-defined objects. The kernel transport moves
  their durable object hashes and can store/read their bytes through `store`,
  but it does not inspect event content or define framework event names.
- Cross-process failures use a stable `KernelErrorPayload` shape with a code,
  message, and optional deterministic-CBOR details instead of language-native
  exception types.
- Compatibility of the transport is governed by Buf `FILE` breaking checks once
  the initial `.proto` baseline exists.

## Explicit Non-Goals

- No `ExecutionHandle.cancel()`, `steer(...)`, `resolveApproval(...)`, or
  approval decision RPCs.
- No driver-loop, provider, tool-execution, host-stream adapter, or public
  runtime API transport.
- No Rust workspace, Rust kernel, Rust gRPC service, or TypeScript remote
  kernel client implementation.
- No fake compatibility-ledger pass claim for cross-language interop before a
  real Rust service exists.
