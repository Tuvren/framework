# Epic AD Framework Deferred-Surface Decisions

## Status

Framework deferred-surface decisions are recorded from the docs-to-authority matrix. Claims with `authority-backed-conformance-covered` are portable only through the named packets/plans/evidence. Every other framework surface below is either local, implementation-defined, deferred, stale-corrected, or queued for Epic AF.

| Surface | Independent Claims | Classifications | Follow-up | Blocks future implementation line? |
| --- | ---: | --- | --- | --- |
| approval and cancellation control | 26 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |
| approval resume semantics | 1 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |
| aroundModel live/durable reconciliation | 2 | missing-conformance-follow-up | KRT-AF003 | Yes, until AF/docs evidence resolves it |
| driver contract | 14 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| extension contracts | 5 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| extension state and prompt contracts | 4 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| framework driver framing | 2 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| framework event stream | 7 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| framework state schema | 3 | implementation-local-evidence | KRT-AF001 if portability is selected | Yes, until AF/docs evidence resolves it |
| future framework drivers | 1 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| handoff and context engineering | 6 | missing-conformance-follow-up | KRT-AF005 | Yes, until AF/docs evidence resolves it |
| host execution handle | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| orchestration optional worker modes | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| orchestration out-of-core boundaries | 8 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| orchestration static config and extension scoping | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| provider API bridge | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| ReAct and extension hooks | 8 | missing-conformance-follow-up | KRT-AF003 | Yes, until AF/docs evidence resolves it |
| runtime and ReAct execution | 8 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime lifecycle recovery | 5 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime loop policy | 1 | missing-conformance-follow-up | KRT-AF003 | Yes, until AF/docs evidence resolves it |
| runtime orchestration | 13 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime resolution and errors | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| shared framework type shapes | 8 | missing-conformance-follow-up | KRT-AF001 | Yes, until AF/docs evidence resolves it |
| stream adapter package topology | 1 | implementation-local-evidence | KRT-AF001 if portability is selected | Yes, until AF/docs evidence resolves it |
| structured output contract | 7 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |
| tool and approval contracts | 7 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |
| tool parallelism and event ordering | 2 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |
| worker subtree event forwarding | 1 | missing-conformance-follow-up | KRT-AF005 | Yes, until AF/docs evidence resolves it |

## Freeze Decisions

- Promote now through Epic AF: claims classified as `missing-conformance-follow-up`, routed to `KRT-AF001`, `KRT-AF003`, `KRT-AF004`, or `KRT-AF005`.
- Implementation-defined: extension storage/composition details, synchronous workers, ordered pipelines, and orchestration static config or extension scoping unless AF promotes them.
- Explicitly deferred: future direct provider packages, worker process management, agent discovery, delegated construction modes, custom future protocols, and ordered pipeline product work.
- Stale docs: preamble wording that implied Markdown was the single machine authority has been corrected by the docs authority notes.
