# Extensions port — authority

The hook/extension port, authored at **87-M7 from existing material
only** (issue #87 §13: "authors the port from existing material and
lifts only the coverage those artifacts already imply — it does not
invent new extension behavior or new conformance").

## The extracted surface (measured at 87-M7)

The extension surface exists today as three implementation-side
artifacts. Per §5's layout rule, language-bearing code never enters
`spec/` — they stay at their implementation homes and this port
documents them:

- **Type surface** — `@tuvren/core/extensions`
  (`typescript/core/src/extensions/index.ts`, a barrel over
  `runtime-contract-shapes.ts`): `TuvrenExtension`, `ExtensionContext`,
  the intercept/lifecycle handler types (`InterceptHandler`,
  `AroundModelHandler`, `AroundToolHandler`, `AfterIterationHandler`,
  `SystemPromptFn`) and their context/result shapes.
- **Runtime facade** — `typescript/runtime/src/lib/extension-runtime.ts`:
  the hook execution engine (ordered/reverse-ordered intercept dispatch
  for `beforeTurn`/`beforeIteration`/`afterTurn`/`afterIteration`,
  per-extension timeouts, resolution composition and precedence,
  extension-state cloning/merging, shared-exports visibility,
  system-prompt collection).
- **Host proof shim** —
  `boundaries/hosts/implementations/typescript/repl/src/lib/proof-extension.ts`
  (moves to the host tree at M9): a minimal working `TuvrenExtension`
  proving the seam end-to-end in the reference shell.

## Authority and conformance disposition (ratified at 87-M7 close)

**No standalone extensions authority packet, TypeSpec source, or
conformance plan exists — and none is authored here.** The
dispositions, grounded in the surfaces that already own this coverage:

- Extension **vocabulary** is `tuvren.shared.core` authority: the
  `extensions` binding section of `spec/core/authority-packet.json`.
  No TypeSpec models back it today anywhere in the repo; the binding
  section plus the TypeScript shapes are the current truth, and
  promoting them to neutral TypeSpec models is future promotion-epic
  work, not M7 extraction.
- Extension **hook behavior** that is conformance-covered today is
  owned by `tuvren.framework.react-runner`
  (`spec/conformance/runners/plans/react-runner-extended.json`: the
  hook-count, phase-ordering, around-tool-nesting, terminal-state and
  around-model check families). The docs freeze gate routes framework
  spec §9 hook-ordering claims to that packet and classifies the rest
  of §9 (storage, composition, custom events, hook policy) as
  implementation-defined pending a future promotion decision.
- The portability inventory's closed-state `expectedPackets` set is
  deliberately unchanged by this port.

This is a pointer, not an oracle: cross-language semantic truth lives
in the referenced authority packets, generated artifacts, and
conformance plans — never in this file.
