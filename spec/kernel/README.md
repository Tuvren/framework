# Kernel Protocol Authority

`spec/kernel/` is the language-neutral authority root for the kernel syscall
contract (GH issue #87 §5): the reviewed CDDL grammar, the authority packet,
and reviewed companion artifacts.

- `authority-packet.json` — the machine-readable authority manifest.
- `cddl/` — reviewed CDDL grammar. Grammar sources here describe shape, not
  behavior.
- `artifacts/` — reviewed-artifact home for emitted kernel protocol support
  artifacts; files here are evidence or implementation support and must stay
  downstream from authored sources and human semantic authority.

Do not use this README, `docs/`, or `.constitution/` as machine authority for
a cross-implementation claim — `authority-packet.json` is the oracle.

The TypeScript reference implementation for `@tuvren/kernel-protocol` and the
Rust implementation live in their respective language trees (see
`authority-packet.json`'s `bindingProjections`).
