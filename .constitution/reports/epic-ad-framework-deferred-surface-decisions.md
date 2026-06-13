# Epic AD Framework Deferred-Surface Decisions

## Status

Framework deferred-surface decisions are recorded from the docs-to-authority matrix. Claims with `authority-backed-conformance-covered` are portable only through the named packets/plans/evidence. Every other framework surface below is local, implementation-defined, deferred, or explicitly outside portable authority.

| Surface | Independent Claims | Classifications | Follow-up | Blocks future implementation line? |
| --- | ---: | --- | --- | --- |
| approval and cancellation control | 27 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |
| approval resume semantics | 1 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |
| aroundModel live/durable reconciliation | 2 | authority-backed-conformance-covered | KRT-AF003 | No, if kept local/deferred |
| capability orchestration | 9 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| driver contract | 14 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| extension contracts | 5 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| extension state and prompt contracts | 4 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| framework driver framing | 2 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| framework event stream | 7 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| framework state schema | 3 | authority-backed-conformance-covered | KRT-AF001 if portability is selected | No, if kept local/deferred |
| future framework drivers | 1 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| handoff and context engineering | 6 | authority-backed-conformance-covered | KRT-AF005 | No, if kept local/deferred |
| host execution handle | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| orchestration optional worker modes | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| orchestration out-of-core boundaries | 8 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| orchestration static config and extension scoping | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| provider API bridge | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| ReAct and extension hooks | 8 | authority-backed-conformance-covered | KRT-AF003 | No, if kept local/deferred |
| runtime and ReAct execution | 8 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime lifecycle recovery | 5 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime loop policy | 1 | authority-backed-conformance-covered | KRT-AF003 | No, if kept local/deferred |
| runtime orchestration | 14 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime resolution and errors | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| shared framework type shapes | 8 | authority-backed-conformance-covered | KRT-AF001 | No, if kept local/deferred |
| stream adapter package topology | 1 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| structured output contract | 7 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |
| tool and approval contracts | 7 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |
| tool parallelism and event ordering | 2 | authority-backed-conformance-covered | KRT-AF004 | No, if kept local/deferred |
| worker subtree event forwarding | 1 | authority-backed-conformance-covered | KRT-AF005 | No, if kept local/deferred |

## Freeze Decisions

- Promoted through Epic AF: selected `KRT-AF001`, `KRT-AF003`, `KRT-AF004`, and `KRT-AF005` rows are now `authority-backed-conformance-covered`.
- Implementation-defined: extension storage/composition details, synchronous workers, ordered pipelines, stream adapter package topology, and orchestration static config or extension scoping unless a later plan promotes them.
- Explicitly deferred: future direct provider packages, worker process management, agent discovery, delegated construction modes, custom future protocols, and ordered pipeline product work.
- Stale docs: preamble wording that implied Markdown was the single machine authority has been corrected by the docs authority notes.
