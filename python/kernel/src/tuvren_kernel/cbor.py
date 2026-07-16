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

"""Canonical CBOR codec for the kernel-record subset.

This module implements RFC 8949 deterministic ("canonical") encoding for
exactly the value subset the kernel protocol grammar allows
(`spec/kernel/cddl/kernel-records.cddl`, `kernel-record` production):

    null / bool / js-safe-int / tstr / bytes / kernel-array / kernel-map

No floats, no tags, no indefinite-length items, and map keys are always text
strings. This is not a general-purpose CBOR library: it deliberately rejects
anything outside that subset so callers can rely on `encode` always producing
the unique canonical byte string for a given kernel record, and `decode`
always rejecting any byte string that is not already in that canonical form
(see `decode`'s docstring for the exact strictness contract).

Encoding rule for maps (RFC 8949 Section 4.2.1, "Length-First Map Key
Ordering", also called "canonical CBOR" or "Core Deterministic Encoding"):
keys are sorted by their own encoded byte string, compared bytewise, which
for the tstr-only keys this codec supports reduces to: shorter encoded key
first, and for equal-length encoded keys, lexicographic comparison of the
encoded bytes (equivalently, of the UTF-8 bytes, since the length prefix is
then identical). `_map_key_sort_key` implements this directly instead of
special-casing "encode then compare", which keeps the sort a pure function of
the UTF-8 bytes and confirmed against every fixture in
`spec/conformance/kernel/fixtures/kernel-protocol-*.json`.
"""

from __future__ import annotations

from typing import Any

# JS-safe integer bounds from the CDDL's `js-safe-int` production
# (`-9007199254740991..9007199254740991`, i.e. +/-(2**53 - 1)).
JS_SAFE_INT_MIN = -9007199254740991
JS_SAFE_INT_MAX = 9007199254740991

_MAJOR_UINT = 0
_MAJOR_NEGINT = 1
_MAJOR_BYTES = 2
_MAJOR_TEXT = 3
_MAJOR_ARRAY = 4
_MAJOR_MAP = 5
_MAJOR_SIMPLE = 7

_SIMPLE_FALSE = 20
_SIMPLE_TRUE = 21
_SIMPLE_NULL = 22

# Explicit recursion depth cap for both encode and decode. Without this,
# a sufficiently deeply nested kernel-array/kernel-map (e.g. 2000 nested
# 0x81 single-element arrays on decode, or an equivalently deep Python
# structure on encode) blows the CPython recursion limit and raises a bare
# `RecursionError`, which is not a `CborDecodeError`/`CborEncodeError` and
# so escapes any caller that only expects this module's own exception
# types -- in the conformance adapter that meant it could escape the
# per-request `dispatch` handler entirely and crash the process. 512 is
# far beyond any depth a real kernel-record tree needs (turn-tree schema
# paths and change-sets are shallow, bounded structures) while staying
# comfortably under Python's default recursion ceiling once this module's
# own call overhead is added on top.
MAX_NESTING_DEPTH = 512


class CborEncodeError(ValueError):
    """Raised when a Python value is outside the kernel-record subset."""


class CborDecodeError(ValueError):
    """Raised when bytes are not canonical kernel-record CBOR."""


def encode(value: Any) -> bytes:
    """Encode `value` as canonical (deterministic) kernel-record CBOR."""

    out = bytearray()
    _encode_into(value, out, 0)
    return bytes(out)


def _encode_into(value: Any, out: bytearray, depth: int) -> None:
    # bool is a subclass of int in Python, so it must be checked first or
    # every boolean would be encoded as an integer 0/1 instead of a CBOR
    # simple value.
    if isinstance(value, bool):
        out.append((_MAJOR_SIMPLE << 5) | (_SIMPLE_TRUE if value else _SIMPLE_FALSE))
        return
    if value is None:
        out.append((_MAJOR_SIMPLE << 5) | _SIMPLE_NULL)
        return
    if isinstance(value, int):
        _encode_int(value, out)
        return
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        _encode_head(_MAJOR_TEXT, len(encoded), out)
        out.extend(encoded)
        return
    if isinstance(value, (bytes, bytearray)):
        _encode_head(_MAJOR_BYTES, len(value), out)
        out.extend(value)
        return
    if isinstance(value, list):
        if depth >= MAX_NESTING_DEPTH:
            raise CborEncodeError(
                f"kernel record nesting exceeds the maximum supported depth ({MAX_NESTING_DEPTH})"
            )
        _encode_head(_MAJOR_ARRAY, len(value), out)
        for item in value:
            _encode_into(item, out, depth + 1)
        return
    if isinstance(value, dict):
        if depth >= MAX_NESTING_DEPTH:
            raise CborEncodeError(
                f"kernel record nesting exceeds the maximum supported depth ({MAX_NESTING_DEPTH})"
            )
        _encode_map(value, out, depth)
        return
    raise CborEncodeError(f"value of type {type(value).__name__} is not a kernel record")


def _encode_map(value: dict[Any, Any], out: bytearray, depth: int) -> None:
    for key in value:
        if not isinstance(key, str):
            raise CborEncodeError("kernel-map keys must be text strings")

    entries = sorted(value.items(), key=lambda pair: _map_key_sort_key(pair[0]))
    _encode_head(_MAJOR_MAP, len(entries), out)
    for key, item in entries:
        _encode_into(key, out, depth + 1)
        _encode_into(item, out, depth + 1)


def _map_key_sort_key(key: str) -> tuple[int, bytes]:
    # Deterministic CBOR map-key ordering compares the *encoded* key bytes.
    # For a tstr key that encoded form is (head, utf8-bytes) where the head
    # encodes the byte length with a minimal-width argument, so head bytes are
    # strictly monotonic in key length at every width tier (0x60..0x77, then
    # 0x78 <len>, 0x79 <len16>, ...). Comparing (byte-length, utf8-bytes)
    # therefore reproduces the RFC 8949 bytewise comparison of the encoded
    # keys exactly, for all key lengths.
    encoded = key.encode("utf-8")
    return (len(encoded), encoded)


def _encode_int(value: int, out: bytearray) -> None:
    if value < JS_SAFE_INT_MIN or value > JS_SAFE_INT_MAX:
        raise CborEncodeError(
            f"integer {value} is outside the js-safe-int range "
            f"[{JS_SAFE_INT_MIN}, {JS_SAFE_INT_MAX}]"
        )
    if value >= 0:
        _encode_head(_MAJOR_UINT, value, out)
    else:
        # CBOR negative integers encode -1-n as the unsigned argument n, per
        # RFC 8949 Section 3.1. There is no CBOR representation of -0
        # distinct from 0, and the boundary already keeps -0 out of records
        # by construction of Python ints (there is no separate -0 int).
        _encode_head(_MAJOR_NEGINT, -1 - value, out)


def _encode_head(major: int, length: int, out: bytearray) -> None:
    prefix = major << 5
    if length < 24:
        out.append(prefix | length)
    elif length < 256:
        out.append(prefix | 24)
        out.append(length)
    elif length < 65536:
        out.append(prefix | 25)
        out.extend(length.to_bytes(2, "big"))
    elif length < 4294967296:
        out.append(prefix | 26)
        out.extend(length.to_bytes(4, "big"))
    else:
        out.append(prefix | 27)
        out.extend(length.to_bytes(8, "big"))


def decode(data: bytes) -> Any:
    """Decode canonical kernel-record CBOR back into a Python value.

    Strictness contract: this decoder is intentionally strict, not lenient.
    It rejects any byte string that could not have come out of `encode`:

    - non-minimal-length integer/length headers (e.g. a `uint8` head that
      encodes a value that fits in the 0-23 immediate range),
    - indefinite-length items (`break`-terminated arrays/maps/strings),
    - floats, tags, and any other major-type-7 simple value besides
      false/true/null,
    - map keys that are not text strings, or a map whose keys are not in
      ascending canonical order (see `_map_key_sort_key`),
    - trailing bytes after the top-level value, and
    - integers outside the CDDL `js-safe-int` range.

    Rejecting non-canonical input here (rather than accepting it liberally)
    is what lets `decode(encode(x)) == x` and `encode(decode(b)) == b` both
    hold for every canonical byte string, which is exactly what the
    `kernel.protocol.schema-roundtrip` conformance check exercises.
    """

    value, offset = _decode_from(data, 0, 0)
    if offset != len(data):
        raise CborDecodeError("trailing bytes after top-level kernel record")
    return value


def _decode_from(data: bytes, offset: int, depth: int) -> tuple[Any, int]:
    if offset >= len(data):
        raise CborDecodeError("unexpected end of input")

    initial_byte = data[offset]
    major = initial_byte >> 5
    info = initial_byte & 0x1F
    offset += 1

    if major == _MAJOR_SIMPLE:
        return _decode_simple(info, offset)

    length, offset = _decode_length(info, data, offset)

    if major == _MAJOR_UINT:
        if length > JS_SAFE_INT_MAX:
            raise CborDecodeError("unsigned integer exceeds js-safe-int range")
        return length, offset
    if major == _MAJOR_NEGINT:
        value = -1 - length
        if value < JS_SAFE_INT_MIN:
            raise CborDecodeError("negative integer exceeds js-safe-int range")
        return value, offset
    if major == _MAJOR_BYTES:
        end = offset + length
        if end > len(data):
            raise CborDecodeError("byte string runs past end of input")
        return data[offset:end], end
    if major == _MAJOR_TEXT:
        end = offset + length
        if end > len(data):
            raise CborDecodeError("text string runs past end of input")
        try:
            return data[offset:end].decode("utf-8", errors="strict"), end
        except UnicodeDecodeError as exc:
            raise CborDecodeError("text string is not valid UTF-8") from exc
    if major == _MAJOR_ARRAY:
        if depth >= MAX_NESTING_DEPTH:
            raise CborDecodeError(
                f"kernel record nesting exceeds the maximum supported depth ({MAX_NESTING_DEPTH})"
            )
        items: list[Any] = []
        for _ in range(length):
            item, offset = _decode_from(data, offset, depth + 1)
            items.append(item)
        return items, offset
    if major == _MAJOR_MAP:
        if depth >= MAX_NESTING_DEPTH:
            raise CborDecodeError(
                f"kernel record nesting exceeds the maximum supported depth ({MAX_NESTING_DEPTH})"
            )
        return _decode_map(length, data, offset, depth)

    raise CborDecodeError(f"unsupported major type {major}")


def _decode_simple(info: int, offset: int) -> tuple[Any, int]:
    if info == _SIMPLE_FALSE:
        return False, offset
    if info == _SIMPLE_TRUE:
        return True, offset
    if info == _SIMPLE_NULL:
        return None, offset
    raise CborDecodeError(
        f"unsupported simple/float value (additional info {info}); "
        "the kernel-record grammar has no floats or unassigned simples"
    )


def _decode_length(info: int, data: bytes, offset: int) -> tuple[int, int]:
    if info < 24:
        return info, offset
    if info == 24:
        if offset >= len(data):
            raise CborDecodeError("truncated 1-byte length")
        value = data[offset]
        if value < 24:
            raise CborDecodeError("non-canonical length: 1-byte form used for value < 24")
        return value, offset + 1
    if info == 25:
        value = _read_uint(data, offset, 2)
        if value < 256:
            raise CborDecodeError("non-canonical length: 2-byte form used for value < 256")
        return value, offset + 2
    if info == 26:
        value = _read_uint(data, offset, 4)
        if value < 65536:
            raise CborDecodeError("non-canonical length: 4-byte form used for value < 65536")
        return value, offset + 4
    if info == 27:
        value = _read_uint(data, offset, 8)
        if value < 4294967296:
            raise CborDecodeError("non-canonical length: 8-byte form used for value < 4294967296")
        return value, offset + 8
    raise CborDecodeError(
        f"unsupported additional info {info}; indefinite lengths are not canonical"
    )


def _read_uint(data: bytes, offset: int, size: int) -> int:
    end = offset + size
    if end > len(data):
        raise CborDecodeError("truncated integer length field")
    return int.from_bytes(data[offset:end], "big")


def _decode_map(length: int, data: bytes, offset: int, depth: int) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    previous_sort_key: tuple[int, bytes] | None = None
    for _ in range(length):
        key, offset = _decode_from(data, offset, depth + 1)
        if not isinstance(key, str):
            raise CborDecodeError("kernel-map keys must decode to text strings")
        sort_key = _map_key_sort_key(key)
        if previous_sort_key is not None and sort_key <= previous_sort_key:
            raise CborDecodeError("kernel-map keys are not in strict canonical ascending order")
        previous_sort_key = sort_key
        item, offset = _decode_from(data, offset, depth + 1)
        result[key] = item
    return result, offset
