# Kernel Interop Transport Authority

This directory owns the authored Protobuf surface for the kernel-only
process-boundary transport.

- The active surface is package `tuvren.kernel.interop.v1`.
- Buf lint and `FILE` breaking checks govern changes from the first baseline
  merge onward.
- Generated language bindings belong under the consuming implementation tree
  and are not authored authority.
- Framework-owned execution controls, provider semantics, host stream adapters,
  and driver-loop behavior stay outside this kernel transport.
- The Nx targets invoke the native Buf-backed scripts directly. `buf` and
  `protoc-gen-es` are expected to come from the already-activated repo
  environment rather than from nested shell wrappers inside Nx commands.
