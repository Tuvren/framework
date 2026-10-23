# KRT-DB004 obligation map

| Legacy planId | checkId | Assertion (1-based) | New claimId or removal reason |
| --- | --- | --- | --- |
| tuvren.kernel.protocol.core | kernel.protocol.deterministic_hashing | 1.resultField | kernel.syscall.protocol.deterministic_hashing |
| tuvren.kernel.protocol.core | kernel.protocol.deterministic_hashing | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.core | kernel.protocol.deterministic_hashing | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.core | kernel.protocol.schema_roundtrip | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.core | kernel.protocol.schema_roundtrip | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.core | kernel.protocol.modify_composition | 1.resultField | kernel.syscall.protocol.modify_composition |
| tuvren.kernel.protocol.core | kernel.protocol.modify_composition | 2.resultField | kernel.syscall.protocol.modify_composition |
| tuvren.kernel.protocol.core | kernel.logical.diff_paths | 1.resultField | kernel.syscall.logical.diff_paths |
| tuvren.kernel.protocol.core | kernel.logical.branch_list | 1.resultField | kernel.syscall.logical.branch_list |
| tuvren.kernel.protocol.core | kernel.logical.recovery_state | 1.resultField | kernel.syscall.logical.recovery_state |
| tuvren.kernel.protocol.core | kernel.logical.recovery_state | 2.resultField | kernel.syscall.logical.recovery_state |
| tuvren.kernel.protocol.core | kernel.logical.recovery_state | 3.resultField | kernel.syscall.logical.recovery_state |
| tuvren.kernel.protocol.core | kernel.lineage.cross_thread_rejection | 1.resultField | kernel.syscall.lineage.cross_thread_rejection |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-empty-bytes | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-empty-bytes |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-empty-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-empty-bytes | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-empty-bytes | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-empty-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-single-byte | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-single-byte |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-single-byte | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-single-byte | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-single-byte | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-single-byte | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-zero-bytes | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-all-zero-bytes |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-zero-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-zero-bytes | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-zero-bytes | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-zero-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-ones-bytes | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-all-ones-bytes |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-ones-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-ones-bytes | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-ones-bytes | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-ones-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-large-bytes | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-large-bytes |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-large-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-large-bytes | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-large-bytes | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-large-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-multi-path-schema | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-multi-path-schema |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-multi-path-schema | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-multi-path-schema | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-multi-path-schema | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-multi-path-schema | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-single-paths | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-all-single-paths |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-single-paths | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-single-paths | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-single-paths | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-single-paths | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-ordered-paths | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-all-ordered-paths |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-ordered-paths | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-all-ordered-paths | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-ordered-paths | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-all-ordered-paths | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-with-prev-turn | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-with-prev-turn |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-with-prev-turn | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-with-prev-turn | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-with-prev-turn | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-with-prev-turn | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-with-event-hash | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-with-event-hash |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-with-event-hash | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-with-event-hash | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-with-event-hash | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-with-event-hash | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-staged-failed | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-staged-failed |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-staged-failed | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-staged-failed | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-staged-failed | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-staged-failed | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-staged-interrupted | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-staged-interrupted |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-staged-interrupted | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-staged-interrupted | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-staged-interrupted | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-staged-interrupted | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-many-staged-results | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-many-staged-results |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-many-staged-results | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-many-staged-results | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-many-staged-results | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-many-staged-results | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-deep-path-schema | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-deep-path-schema |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-deep-path-schema | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-deep-path-schema | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-deep-path-schema | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-deep-path-schema | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-non-utf8-bytes | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-non-utf8-bytes |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-non-utf8-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-non-utf8-bytes | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-non-utf8-bytes | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-non-utf8-bytes | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-zero-turn-tree-hash | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-zero-turn-tree-hash |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-zero-turn-tree-hash | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-zero-turn-tree-hash | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-zero-turn-tree-hash | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-zero-turn-tree-hash | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-mixed-status-staged | 1.resultField | kernel.syscall.protocol.deterministic_hashing.f-mixed-status-staged |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-mixed-status-staged | 2.resultField | SPEC-DB004-01: catalog has no arbitrary schema-record encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.deterministic_hashing.f-mixed-status-staged | 3.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode identity encoder/hash syscall |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-mixed-status-staged | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder (codec.decodeDeterministicKernelRecord); kernel.syscall.protocol.schema_canonical_cbor covers kernel-returned schema records only |
| tuvren.kernel.protocol.extended | kernel.protocol.schema_roundtrip.f-mixed-status-staged | 2.resultField | SPEC-DB004-01: catalog has no arbitrary TurnNode record decoder; kernel.syscall.protocol.node_identity_walk covers read-back of kernel-produced nodes only |
| tuvren.kernel.protocol.extended | kernel-protocol-af.schema-register-rejects-duplicate-path | 1.resultField | kernel.syscall.kernel-protocol-af.schema-register-rejects-duplicate-path |
| tuvren.kernel.protocol.extended | kernel-protocol-af.tree-create-rejects-missing-required-path | 1.resultField | kernel.syscall.kernel-protocol-af.tree-create-rejects-missing-required-path |
| tuvren.kernel.protocol.extended | kernel-protocol-af.tree-diff-rejects-schema-mismatch | 1.resultField | kernel.syscall.kernel-protocol-af.tree-diff-rejects-schema-mismatch |
| tuvren.kernel.protocol.extended | kernel-protocol-af.run-create-rejects-busy-branch | 1.resultField | kernel.syscall.kernel-protocol-af.run-create-rejects-busy-branch |
| tuvren.kernel.protocol.extended | kernel-protocol-af.run-begin-step-rejects-out-of-order-step | 1.resultField | kernel.syscall.kernel-protocol-af.run-begin-step-rejects-out-of-order-step |
| tuvren.kernel.protocol.extended | kernel-protocol-af.run-complete-rejects-missing-event-object | 1.resultField | kernel.syscall.kernel-protocol-af.run-complete-rejects-missing-event-object |
| tuvren.kernel.protocol.extended | kernel-protocol-af.branch-set-head-rejects-lateral-lineage | 1.resultField | kernel.syscall.kernel-protocol-af.branch-set-head-rejects-lateral-lineage |
| tuvren.kernel.protocol.extended | kernel.logical.thread_list | 1.resultField | kernel.syscall.logical.thread_list |
| tuvren.kernel.protocol.extended | kernel.logical.thread_list | 2.resultField | kernel.syscall.logical.thread_list |
| tuvren.kernel.protocol.extended | kernel.logical.thread_list | 3.resultField | kernel.syscall.logical.thread_list |
| tuvren.kernel.protocol.extended | kernel.logical.thread_list | 4.resultField | kernel.syscall.logical.thread_list |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 1.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 2.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 3.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 4.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 5.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 6.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 7.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 8.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 9.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 10.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 11.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 12.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 13.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.canonical_rejection | 14.resultField | SPEC-DB004-01: no catalogued deterministic CBOR decoder; retain legacy control pending authority |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 1.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 2.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 3.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 4.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 5.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 6.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 7.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |
| tuvren.kernel.protocol.extended | kernel.protocol.modify_composition.f-verdict-composition | 8.resultField | kernel.syscall.protocol.modify_composition.f-verdict-composition |

## Specification findings

SPEC-DB004-01: The catalog exposes no deterministic record encode/decode or arbitrary TurnNode identity hashing syscall. Canonical rejection and arbitrary CBOR roundtrip/hash obligations cannot migrate. No composite operation was added. Legacy plans and their canonical-decoder mutant remain active. Native schema registration/read and opaque object storage are migrated; they do not claim arbitrary decoder conformance.

SPEC-DB004-02: turn_head_lateral_move has no authority. Its adapter mapping is removed. The native kernel_runtime_turn_head_lineage_mismatch remains unchanged. rust/kernel/src/memory.rs and rust/kernel-grpc-service/src/lib.rs still emit or map turn_head_lateral_move; these Rust paths are out of scope for this fix.

## Removed unit tests

- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `returns a truthy RuntimeKernel instance`: self-asserting object/namespace existence; syscall traces exercise real behavior.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `kernel has expected syscall namespaces`: self-asserting object/namespace existence; syscall traces exercise real behavior.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `verdicts.compose priority: abort wins over proceed`: covered by runner-owned verdict-composition fixture assertions in the new plans.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `verdicts.compose priority: abort wins over retry`: covered by runner-owned verdict-composition fixture assertions in the new plans.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `verdicts.compose returns proceed when all proceed`: covered by runner-owned verdict-composition fixture assertions in the new plans.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `verdicts.compose preserves a single modify verdict unchanged`: covered by runner-owned verdict-composition fixture assertions in the new plans.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `verdicts.compose preserves multiple modify verdicts in registration order`: covered by runner-owned verdict-composition fixture assertions in the new plans.
- `typescript/kernel/runtime/test/runtime-kernel.foundation.test.ts` / `verdicts.compose keeps pause ahead of composed modify verdicts`: covered by runner-owned verdict-composition fixture assertions in the new plans.

- `typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` / `kernel.wrong-opaque-object-hash activates through its detecting checks on memory`: replaced by the shared negative-control runner, which executes the new traces, proves activation, and grades designated assertions; response inequality alone was not conformance proof.

- `typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` / `kernel.wrong-opaque-object-hash alters a designated observation before the adapter reports it`: replaced by the shared negative-control runner, which executes the new traces, proves activation, and grades designated assertions; response inequality alone was not conformance proof.

- `typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` / `kernel.noncanonical-changed-paths-order activates through its detecting checks on memory`: replaced by the shared negative-control runner, which executes the new traces, proves activation, and grades designated assertions; response inequality alone was not conformance proof.

- `typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` / `kernel.noncanonical-changed-paths-order alters a designated observation before the adapter reports it`: replaced by the shared negative-control runner, which executes the new traces, proves activation, and grades designated assertions; response inequality alone was not conformance proof.

- `typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` / `kernel.drop-uncommitted-staged-result-on-recovery activates through its detecting checks on memory`: replaced by the shared negative-control runner, which executes the new traces, proves activation, and grades designated assertions; response inequality alone was not conformance proof.

- `typescript/kernel/conformance-adapter/test/mutant-adapter.test.ts` / `kernel.drop-uncommitted-staged-result-on-recovery alters a designated observation before the adapter reports it`: replaced by the shared negative-control runner, which executes the new traces, proves activation, and grades designated assertions; response inequality alone was not conformance proof.

- `typescript/kernel/runtime/test/runtime-kernel.test.ts` / `keeps package-local runtime-kernel test discovery rooted in this folder`: removed the empty placeholder test, which has no assertions or behavior. The package target runs `bun test` and discovers the adjacent real test files directly.

## Scope and code decisions

- CD-DB004-01: Add the opt-in plan field `certificationRules: "enforcing"` to the existing plan schema, type, and certification assessment. Profile-based migration remains available. Kernel.syscall capability gates and argument-projected, non-deprecated catalogued syscalls also force enforcement. Legacy composites remain in report mode.
- CD-DB004-02: Permit assertions and captures on the runner-owned `state.adapterError` envelope, and its `code` and `message`, only when the operation declares native error codes; literal equality codes must belong to that operation’s errors list. Native failures remain error outcomes. The adapter never writes `result.error`.
- CD-DB004-03: The plan validator admits kernel operations from each packet-referenced validated operation catalog, alongside its legacy declaration sources. Its previous legacy-plan scan rejected catalogued syscalls.
- CD-DB004-04: Use protocol instance lifecycle callbacks to retain one native kernel per trace and dispose its backend afterward. Bind each syscall by its public argument order. Bytes and arbitrary records use the existing `$bytes` and `$map` encoding. No dependency was added.
- CD-DB004-05: Extend the existing opaque-hash mutant with a native store seam. It appends the same byte as its codec seam before calling native storage, so the returned wrong hash still resolves and the runner can grade it without unresolved operands.
- Scope deviation: Register both plans in `spec/kernel/authority-packet.json`, preserving all legacy entries. The compiler, validator, and plan schema changes are required to enforce the migrated plans and admit native error observations.

## Remaining limitations

- SPEC-DB004-01 blocks canonical rejection and arbitrary schema/node CBOR hash and node-decoding migration. Its negative control stays designated to the unchanged legacy plan. This is incomplete ticket scope under the STOP rule, not a passing decoder claim.
- The catalogued `kernel.clock.set` and `kernel.fault.arm` controls are not implemented by this milestone. Their runner-owned clock, arming-token, occurrence, block-mode, and handle lifecycle mechanisms belong to the later lifecycle/fault work. Binding them to the old in-process scenario seam would violate the pinned contract. Every catalogued native syscall is bound; the mutant activation control remains mutant-only.
- `kernel.fault-seam-never-fires` remains unsupported because the existing runner has no missing-fault-activation rejection channel. `kernel.lease-takeover-before-expiry` remains invalid on `kernel.memory` because its designated checks require the shared-lease-clock capability. Neither is counted as killed.

- CD-DB004-06: Forward optional native error details and causal envelopes without changing native codes. Reject malformed lossless tags and duplicate map keys instead of dropping input data. The public bridge contract test was red before these fixes and passes afterward.
- Required scope deviation: Regenerate `reports/compatibility/` with `bun run compatibility:evidence`. `verify:kernel` otherwise rejects the unchanged matrix and evidence because the plan topology and three TypeScript manifests changed. This is generated evidence, not a change to legacy plans or fixtures.
- Lifecycle limitation: Persistent syscall instances reuse the existing configured-backend provisioning and cleanup helper. Harness-owned `storageRef` allocation remains later lifecycle scope; these protocol traces make no process-crash claim.

## Read-back claims added in review

- `kernel.syscall.protocol.schema_canonical_cbor` → Partially covers `kernel.protocol.schema_roundtrip` assertion 1: `schema.get` returns a record whose canonical CBOR matches the committed schema vector. Arbitrary deterministic-CBOR decoding and malformed-input rejection still require a codec operation.
- `kernel.syscall.protocol.node_identity_walk` → Partially covers `kernel.protocol.schema_roundtrip` assertion 2 and `kernel.protocol.deterministic_hashing` assertion 3: `node.get` and `node.walkBack` return checkpoint records whose identities match kernel-reported hashes. The three-node parent chain and the checkpoint manifest's object references resolve to independently verified records or bytes. Arbitrary TurnNode fixture decoding, canonical-byte comparison, and rejection cases still require a codec operation.
- `kernel.syscall.protocol.tree_manifest_identity` → Partially covers the TurnTree decoder and identity obligations: `tree.create` returns the committed TurnTree fixture digest, and `tree.manifest` and `tree.resolve` return its expected references. Decoding arbitrary TurnTree bytes, checking stored canonical bytes, and rejecting malformed encodings still require a codec operation. The public tree API returns a manifest rather than a full `{schemaId, manifest}` record, so this claim compares the kernel-reported identity with the committed digest.
