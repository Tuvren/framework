### ADR-016 Shape Contracts, Behavioral Conformance, and Interop Transport Stay Separate

- **Status:** accepted
- **Context:** A single technology cannot cleanly express every kind of runtime authority Tuvren needs across framework contracts, kernel records, behavior fixtures, and cross-process transport.
- **Decision:** Keep shape contracts, behavioral conformance, and interop transport as separate layers. Framework/provider shape contracts use boundary-owned contract packages; kernel record grammar uses boundary-owned protocol grammar; observable behavior uses boundary-owned conformance suites; and cross-process transport uses boundary-owned interop contracts only where a boundary actually crosses process or language seams.
- **Consequences:** No schema language or transport definition silently becomes the meaning of the runtime. Implementations must satisfy both shape and behavior requirements, and interop may evolve on its own version track when needed.

