# Epic AD Kernel, Backend, and Provider Local-Surface Decisions

## Status

Kernel, backend, provider, and tool surfaces are separated from cross-language authority unless the matrix maps them to a packet, shared plan, fixture, adapter capability, and compatibility evidence.

| Surface | Independent Claims | Classifications | Follow-up | Blocks future implementation line? |
| --- | ---: | --- | --- | --- |
| kernel appendix validation matrix | 21 | authority-backed-conformance-covered | KRT-AF006 | No, if kept local/deferred |
| kernel backend acceleration indexes | 2 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| kernel backend physical storage | 2 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| kernel boundary framing | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel capability-gated syscalls | 3 | missing-conformance-follow-up | KRT-AM010 | Yes, until AF/docs evidence resolves it |
| kernel deferred maintenance surfaces | 1 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| kernel docs-to-authority framing | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| kernel invariants | 9 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel logical operations | 14 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel protocol records | 11 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel recovery edge states | 3 | authority-backed-conformance-covered | KRT-AF006 | No, if kept local/deferred |
| kernel run liveness | 10 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel storage structural sharing | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| provider API bridge | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| tool and approval contracts | 7 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |
| tool parallelism and event ordering | 2 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |

## Decisions

- Official backend guarantees: kernel logical behavior is portable through `tuvren.kernel.protocol`; backend physical storage, acceleration indexes, SQLite details, and process-local choices remain implementation-defined.
- Provider behavior: provider-neutral bridge behavior is portable through `tuvren.providers.provider-api`; provider-family packages and native wire-format mechanics remain deferred or local.
- Tool and approval behavior: the provider-neutral rows selected by `KRT-AF004` are now shared-conformance-covered; provider-family-native mechanics remain local or deferred.
- Optional extensions: run-liveness remains capability-gated through `kernel.run-liveness`; it is not retroactively folded into the base protocol for implementations that do not advertise it.
