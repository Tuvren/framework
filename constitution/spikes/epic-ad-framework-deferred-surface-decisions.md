# Epic AD Framework Deferred-Surface Decisions

## Status

Framework deferred-surface decisions are recorded from the docs-to-authority matrix. Claims with `authority-backed-conformance-covered` are portable only through the named packets/plans/evidence. Every other framework surface below is either local, implementation-defined, deferred, stale-corrected, or queued for Epic AF.

| Surface | Claims | Classifications | Follow-up | Blocks future implementation line? |
| --- | ---: | --- | --- | --- |
| driver contract | 11 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| extension contracts | 8 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| framework driver framing | 2 | implementation-defined | N/A unless AF promotes the surface | No, if kept local/deferred |
| framework event stream | 18 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| framework state schema | 4 | implementation-local-evidence | KRT-AF001 if portability is selected | Yes, until AF/docs evidence resolves it |
| framework uncategorized local surface | 33 | implementation-local-evidence | KRT-AF001 if portability is selected | Yes, until AF/docs evidence resolves it |
| future framework drivers | 1 | explicitly-deferred | Future TechSpec/Tasks revision after TypeScript freeze closure | No, if kept local/deferred |
| host execution handle | 4 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| provider API bridge | 2 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| ReAct and extension hooks | 1 | missing-conformance-follow-up | KRT-AF003 | Yes, until AF/docs evidence resolves it |
| runtime and ReAct execution | 11 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime lifecycle recovery | 5 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| runtime resolution and errors | 3 | authority-backed-conformance-covered | N/A | No, if kept local/deferred |
| shared framework type shapes | 20 | missing-conformance-follow-up | KRT-AF001 | Yes, until AF/docs evidence resolves it |
| tool and approval contracts | 6 | missing-conformance-follow-up | KRT-AF004 | Yes, until AF/docs evidence resolves it |

## Freeze Decisions

- Promote now through Epic AF: claims classified as `missing-conformance-follow-up`, routed to `KRT-AF001`, `KRT-AF003`, `KRT-AF004`, or `KRT-AF005`.
- Implementation-defined: extension storage/composition details, synchronous workers, ordered pipelines, and orchestration static config or extension scoping unless AF promotes them.
- Explicitly deferred: future direct provider packages, worker process management, agent discovery, delegated construction modes, custom future protocols, and ordered pipeline product work.
- Stale docs: preamble wording that implied Markdown was the single machine authority has been corrected by the docs authority notes.
