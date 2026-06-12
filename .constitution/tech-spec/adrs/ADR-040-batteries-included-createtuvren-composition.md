### ADR-040 Batteries-Included `createTuvren({...})` Composition

- **Status:** accepted
- **Context:** PRD v0.7.0 CAP-P0-048 requires a single batteries-included entrypoint that assembles kernel, backend, driver registry, and framework runtime from one factory call. Architecture v0.7.0 places this as the Batteries-Included Composition responsibility on the Curated Host-Facing SDK Surface. Today host developers compose `createMemoryBackend` → `createRuntimeKernel` → `createDriverRegistry([createReActDriver(...)])` → `createTuvrenRuntimeCore({...})` from at least four packages.
- **Decision:** Add `createTuvren({...})` as the sole root export of `@tuvren/runtime`. Signature:
  ```ts
  export type BackendKind = "memory" | "sqlite" | "postgres";
  export type DriverKind = "react";

  export interface CreateTuvrenOptions {
    backend:
      | BackendKind
      | RuntimeBackend
      | { kind: "memory"; options?: MemoryBackendOptions }
      | { kind: "sqlite"; options: SqliteBackendOptions }
      | { kind: "postgres"; options: PostgresBackendOptions };
    driver?:
      | DriverKind
      | RuntimeDriverFactory
      | { kind: "react"; options?: ReActDriverOptions };
    provider?: TuvrenProvider;
    tools?: Array<TuvrenToolDefinition | McpToolSource>;
    extensions?: TuvrenExtension[];
    telemetry?: TuvrenTelemetrySink;
    bounds?: ExecutionBounds;
    kernel?: RuntimeKernel;
    runtimeOptions?: Omit<RuntimeCoreOptions, "kernel" | "driverRegistry" | "defaultDriverId">;
  }

  export interface TuvrenInstance {
    runtime: TuvrenRuntime;
    orchestration: OrchestrationRuntime;
    kernel: RuntimeKernel;
    provider?: TuvrenProvider;
    [Symbol.asyncDispose](): Promise<void>;
  }

  export function createTuvren(options: CreateTuvrenOptions): Promise<TuvrenInstance>;
  ```
  Defaults: `backend` is mandatory (no surprise persistence choice); `driver` defaults to `"react"`; `provider` is optional (turns may pass per-call providers in `AgentConfig.model`); `tools` accepts both literal `TuvrenToolDefinition` arrays and `McpToolSource` references that contribute their `.tools` to the global registry; `extensions` is optional. The factory wires the chosen backend through the appropriate backend factory, constructs the kernel via `createRuntimeKernel({ backend })`, builds a driver registry containing the requested driver, and constructs the framework runtime via the existing internal `createTuvrenRuntimeCore` (now an internal helper of `@tuvren/runtime`). `[Symbol.asyncDispose]` closes any MCP tool sources, releases backend resources (closes the SQLite file handle, returns the PostgreSQL pool, etc.), and resolves any pending kernel work cleanly. Prefer the kind-tagged shorthand form `{ backend: "sqlite", options: { databasePath: "./db" } }` over the explicit `RuntimeBackend` factory form; the shorthand is more readable and makes the batteries-included intent explicit. Passing a pre-built `RuntimeBackend` remains legal for advanced composition scenarios.
- **Consequences:** `@tuvren/runtime/src/index.ts` exports only `createTuvren`, the curated primitive re-exports from `@tuvren/core/*` subpaths, the backend factories, the kernel factories, the driver factory, and the orchestration runtime factory. The current `createTuvrenRuntimeCore` is renamed to `createTuvrenRuntime` internally (per Architecture §1 principle that internals must not bleed into the public name). The convenience composition is the only batteries-included entrypoint; advanced hosts that need fine-grained control still import the lower-level factories from `@tuvren/runtime` (they remain re-exported) or compose them from `@tuvren/core/execution` types and the leaf packages directly. A new conformance check set `runtime-api-batteries-included` in `runtime-api-callables-extended.json` exercises the factory's compositional correctness.

