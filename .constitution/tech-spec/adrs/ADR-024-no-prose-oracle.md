### ADR-024 No Prose Oracle

- **Status:** accepted
- **Context:** Markdown under `docs/`, `.constitution/`, `AGENTS.md`, and boundary `README.md` placeholders is essential for rationale, workflow, planning, ADRs, and reviewer handoffs, but it is not executable. Treating prose as the source of a binding cross-language semantic produces silent drift between text, generated artifacts, and implementation behavior.
- **Decision:** No acceptance criterion, conformance claim, compatibility claim, release gate, or interop check may depend solely on Markdown. Every binding cross-language semantic claim must cite or derive from a machine authority packet (ADR-026), generated artifact, conformance plan, or measured evidence file. Markdown remains the home for rationale, workflow, ADRs, decision records, summaries, and review prose, paired with the executable artifacts that carry the actual contract.
- **Consequences:** README placeholders that today say "TypeScript implementation is the source of truth" or "see docs/ for semantics" are not authority and must be paired with an authority packet entry before the surface can be claimed cross-language. `docs/KrakenKernelSpecification.md` and `docs/KrakenFrameworkSpecification.md` retain their role as human authority chain inputs but cannot satisfy a portability claim by themselves.

