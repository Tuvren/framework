# Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Milestone M4 coverage for the `kernel.reclamation.erasure-probe`
operation and its crypto-shredding internals -- the one place in this port
that depends on the `cryptography` package (a dependency of this adapter
project only, never of `tuvren_kernel` itself)."""

from __future__ import annotations

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from tuvren_kernel_adapter import operations


def test_run_erasure_probe_reports_all_true() -> None:
    result = operations.run_erasure_probe(None)
    erasure = result["result"]["erasure"]

    assert erasure == {
        "recoverableBeforeErasure": True,
        "unrecoverableAfterErasure": True,
        "lineageStructurallyIntactAfterErasure": True,
    }
    # `_projection` mirrors the shared `{"result": ..., "evidence": ...}`
    # envelope every adapter operation returns.
    assert result["evidence"] == result["result"]


def test_run_erasure_probe_is_reusable_across_dispatches() -> None:
    """Each dispatch builds a fresh kernel -- calling twice must not leak state."""

    first = operations.run_erasure_probe(None)
    second = operations.run_erasure_probe(None)
    assert first["result"]["erasure"] == second["result"]["erasure"]


def test_aes_gcm_envelope_roundtrip_and_key_destruction_semantics() -> None:
    """Unit-level proof of the crypto-shredding primitive the probe relies on."""

    key: bytes | None = AESGCM.generate_key(bit_length=256)
    plaintext = b"sensitive-untrusted-edge-payload"
    nonce = b"\x00" * 12
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
    envelope = nonce + ciphertext

    # Recoverable while the key survives.
    decrypted = AESGCM(key).decrypt(envelope[:12], envelope[12:], None)
    assert decrypted == plaintext

    # After destroying the only key reference, the identical ciphertext is
    # unrecoverable -- the ciphertext itself is untouched (still stored,
    # still authentic), only the key is gone.
    key = None
    assert key is None

    # A wrong key (simulating "erasure destroyed this key, but a caller
    # tries an unrelated one") always fails AES-GCM's authentication tag
    # check rather than silently returning garbage plaintext.
    wrong_key = AESGCM.generate_key(bit_length=256)
    try:
        AESGCM(wrong_key).decrypt(envelope[:12], envelope[12:], None)
    except InvalidTag:
        pass
    else:
        raise AssertionError("expected InvalidTag when decrypting with an unrelated key")
