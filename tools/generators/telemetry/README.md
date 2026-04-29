# Telemetry Generator Inputs

This directory documents the Epic R telemetry generation posture.

- Authored semantic-convention source lives in `telemetry/semconv/`.
- `generator-plan.json` records the current TypeScript output plus the deferred
  Rust output path.
- `templates/` keeps the repo-owned helper template paths checked in even
  though Epic R only generates the TypeScript consumer today.
- `weaver` validates and packages the registry during code generation.
- `tools/scripts/telemetry-codegen.ts` emits the reviewed markdown summary,
  attribute registry JSON, and the generated TypeScript helper.
