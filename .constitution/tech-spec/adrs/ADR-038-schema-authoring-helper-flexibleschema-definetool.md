### ADR-038 Schema Authoring Helper: `FlexibleSchema` + `defineTool`

- **Status:** accepted
- **Context:** PRD v0.7.0 CAP-P0-040 requires a schema-agnostic tool-authoring helper that accepts Zod (v3 and v4), Standard Schema, and wrapped JSON Schema with strict TypeScript inference, while preserving the existing `CustomSchema` boundary contract for raw JSON Schema. Architecture v0.7.0 establishes the Schema Authoring Helper as a host-facing authoring boundary that normalizes authoring shapes into the boundary contract through a centralized detection routine with explicit precedence. The Vercel AI SDK's `tool()` + `FlexibleSchema` + `asSchema()` pattern is the proven precedent and aligns directly with this requirement.
- **Decision:** Add a `defineTool({...})` helper to `@tuvren/core/tools` with the signature:
  ```ts
  export function defineTool<INPUT, OUTPUT>(
    options: {
      name: string;
      description: string;
      inputSchema: FlexibleSchema<INPUT>;
      execute: (input: INPUT, context: ToolExecutionContext) => Promise<OUTPUT> | OUTPUT;
      approval?: ApprovalPolicy;
      timeout?: number;
      metadata?: Record<string, unknown>;
    },
  ): TuvrenToolDefinition;
  ```
  with `FlexibleSchema<INPUT>` defined as `Schema<INPUT> | ZodSchema<INPUT> | StandardSchema<INPUT> | LazySchema<INPUT> | TuvrenJsonSchema` where `Schema<INPUT>` is a Tuvren-branded wrapper carrying `_type: INPUT` and `jsonSchema: TuvrenJsonSchema`, and the bare `TuvrenJsonSchema` member is the legacy path that produces `INPUT = unknown`. The centralized `asSchema(schema)` normalizer routes by **fixed precedence**:
  1. Already-wrapped: `schemaSymbol in schema` → use directly
  2. Zod v4 marker: `'_zod' in schema` → wrap with `zodSchema(...)`
  3. Standard Schema marker: `'~standard' in schema` (and vendor is not `'zod'`) → wrap with `standardSchema(...)`
  4. Standard Schema with `vendor === 'zod'` → wrap with `zodSchema(...)` (Zod v3 path via Standard Schema interop)
  5. Lazy function: `typeof schema === 'function'` → invoke and recurse
  6. Bare `TuvrenJsonSchema` object (legacy CustomSchema interop) → coerce via existing `CustomSchema` path with `INPUT = unknown`
  The precedence is part of the Schema Authoring Helper authority and is conformance-checked through a new `runtime-api-schema-authoring` check set added to the existing `runtime-api-callables-extended.json` plan (not a standalone plan file). Exported helpers: `defineTool`, `asSchema`, `jsonSchema<T>(schema: TuvrenJsonSchema, opts?: { validate? }): Schema<T>`, `zodSchema<T>(schema: ZodTypeLike): Schema<T>`, `standardSchema<T>(schema: StandardSchemaV1<unknown, T>): Schema<T>`. `zodSchema` and `standardSchema` are exported but most consumers will pass the source schema directly to `inputSchema` and let `asSchema` route. The boundary `CustomSchema` contract (`toJSONSchema(): TuvrenJsonSchema` + `validate(input): ValidationResult`) is preserved unchanged; `defineTool` produces a `TuvrenToolDefinition` whose `inputSchema` field carries the normalized `CustomSchema` shape that the Tool Execution Gateway has always accepted.
- **Consequences:** `@tuvren/core/tools` adds the new helpers and the `FlexibleSchema`, `Schema`, `ZodSchema`, `StandardSchema`, `LazySchema` type exports. `zod@4.4.3` and `@standard-schema/spec@1.1.0` become optional `peerDependencies` of `@tuvren/core` (declared as `peerDependenciesMeta.<name>.optional = true`). Hosts not authoring tools through Zod or Standard Schema do not install either. The detection routine's precedence is fixture-tested with at least one fixture per branch including ambiguous cases (Zod v3 schema that also implements `~standard` with `vendor === 'zod'` — routes through Zod path; lazy function returning a Zod v4 schema — recurses correctly; bare `TuvrenJsonSchema` object — wraps via legacy path with `INPUT = unknown`). The Tool Execution Gateway requires no changes; it continues to operate on `TuvrenToolDefinition` whose `inputSchema` is a `CustomSchema` after normalization.

