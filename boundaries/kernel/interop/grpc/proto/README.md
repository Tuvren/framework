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
- The Nx targets enter `devenv shell --` before invoking Buf-backed scripts.
  `buf` and `protoc-gen-es` remain native Devenv tools by policy, not npm
  package scripts.
