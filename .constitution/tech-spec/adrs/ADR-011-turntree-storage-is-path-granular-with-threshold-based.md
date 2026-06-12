### ADR-011 TurnTree Storage Is Path-Granular with Threshold-Based Chunking for Ordered Paths

- **Status:** accepted
- **Context:** The kernel contract is expressed in path values, not in generic subtree fragments. Ordered paths such as `messages` can grow large enough that flat rewrites become expensive, but a fully generic Merkle-fragment engine would overfit the problem.
- **Decision:** TurnTree semantics remain path-granular. Ordered paths are logically `Hash[]`; single paths are logically `Hash | null`. Internally, ordered paths start flat and may promote to append-optimized fixed-size chunked storage after crossing an implementation-defined threshold. Chunking is invisible at the protocol layer.
- **Consequences:** The public model stays simple while long ordered paths avoid pathological rewrite amplification. Numeric threshold and chunk-size values remain implementation constants, not protocol constants.

