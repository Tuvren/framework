# Epic AD Kernel, Backend, and Provider Local-Surface Decisions

## Status

Kernel, backend, provider, and tool surfaces are separated from cross-language authority unless the matrix maps them to a packet, shared plan, fixture, adapter capability, and compatibility evidence.

| Surface | Claims | Classifications | Follow-up | Blocks future implementation line? |
| --- | ---: | --- | --- | --- |
| kernel appendix validation matrix | 20 | missing-conformance-follow-up | KRT-AF006 | Yes, until AF/docs evidence resolves it |
| kernel backend acceleration indexes | 2 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| kernel backend physical storage | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| kernel boundary framing | 3 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel deferred maintenance surfaces | 1 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| kernel invariants | 9 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel logical operations | 14 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel protocol records | 11 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel recovery edge states | 3 | missing-conformance-follow-up | KRT-AF006 | Yes, until AF/docs evidence resolves it |
| kernel run liveness | 10 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| kernel storage structural sharing | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| provider API bridge | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| tool and approval contracts | 7 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |

## Decisions

- Official backend guarantees: kernel logical behavior is portable through `tuvren.kernel.protocol`; backend physical storage, acceleration indexes, SQLite details, and process-local choices remain implementation-defined.
- Provider behavior: provider-neutral bridge behavior is portable through `tuvren.providers.provider-api`; provider-family packages and native wire-format mechanics remain deferred or local.
- Tool and approval behavior: current TypeScript artifacts and runtime checks are implementation evidence until `KRT-AF004` promotes neutral checks into shared conformance.
- Optional extensions: run-liveness remains capability-gated through `kernel.run-liveness`; it is not retroactively folded into the base protocol for implementations that do not advertise it.
