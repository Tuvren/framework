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

"""SHA-256 record identity per `docs/KrakenKernelSpecification.md` Section 2.3.

Record identity hashes are always the SHA-256 digest of *canonical* CBOR
bytes, lowercase-hex encoded (matching the CDDL `hash-string` production:
`tstr .regexp "^[0-9a-f]{64}$"`). The one exception, confirmed against the
`rawOpaqueBytesSha256Hex` field in every `spec/conformance/kernel/fixtures/
kernel-protocol-*.json` fixture, is opaque object bytes: those are hashed
directly, with no CBOR wrapping, because they are already the canonical
representation of a stored blob (see `kernel-object.bytes` /
`stored-object.bytes` in `spec/kernel/cddl/kernel-records.cddl`).
"""

from __future__ import annotations

import hashlib
from typing import Any

from tuvren_kernel.cbor import encode


def sha256_hex(data: bytes) -> str:
    """Return the lowercase-hex SHA-256 digest of `data`."""

    return hashlib.sha256(data).hexdigest()


def hash_raw_bytes(data: bytes) -> str:
    """Hash raw opaque object bytes directly (no CBOR wrapping)."""

    return sha256_hex(bytes(data))


def hash_kernel_record(record: Any) -> str:
    """Hash a kernel record: SHA-256 of its canonical CBOR encoding."""

    return sha256_hex(encode(record))
