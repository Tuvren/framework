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

"""Direct unit tests for the canonical CBOR codec's edge cases.

The fixture-driven tests in `test_kernel_records.py` are the primary oracle
for real kernel-record shapes; this module covers codec-level edge cases
(integer boundaries, bool-vs-int, key sorting, strict-decode rejections)
that the fixtures don't necessarily exercise directly.
"""

from __future__ import annotations

import pytest

from tuvren_kernel.cbor import CborDecodeError, CborEncodeError, decode, encode


def test_bool_is_not_encoded_as_integer() -> None:
    assert encode(True) == bytes([0xF5])
    assert encode(False) == bytes([0xF4])
    assert encode(1) == bytes([0x01])
    assert encode(0) == bytes([0x00])


def test_null_encoding() -> None:
    assert encode(None) == bytes([0xF6])


@pytest.mark.parametrize(
    "value,expected_hex",
    [
        (0, "00"),
        (23, "17"),
        (24, "1818"),
        (255, "18ff"),
        (256, "190100"),
        (65535, "19ffff"),
        (65536, "1a00010000"),
        (4294967295, "1affffffff"),
        (4294967296, "1b0000000100000000"),
        (-1, "20"),
        (-24, "37"),
        (-25, "3818"),
    ],
)
def test_integer_minimal_length_encoding(value: int, expected_hex: str) -> None:
    assert encode(value).hex() == expected_hex


def test_integer_out_of_js_safe_range_rejected() -> None:
    with pytest.raises(CborEncodeError):
        encode(9007199254740992)
    with pytest.raises(CborEncodeError):
        encode(-9007199254740992)


def test_float_is_rejected() -> None:
    with pytest.raises(CborEncodeError):
        encode(1.5)


def test_map_keys_are_sorted_by_length_then_lexicographic() -> None:
    value = {"schemaId": 1, "paths": 2, "incorporationRules": 3}
    encoded = encode(value)
    decoded_keys_in_order = []
    cursor = encoded
    # major type 5 (map) header for 3 pairs is 0xa3
    assert cursor[0] == 0xA3
    offset = 1
    for _ in range(3):
        key, offset = _read_text(cursor, offset)
        decoded_keys_in_order.append(key)
        _, offset = _skip_value(cursor, offset)
    assert decoded_keys_in_order == ["paths", "schemaId", "incorporationRules"]


def _read_text(data: bytes, offset: int) -> tuple[str, int]:
    length = data[offset] & 0x1F
    offset += 1
    text = data[offset : offset + length].decode("utf-8")
    return text, offset + length


def _skip_value(data: bytes, offset: int) -> tuple[None, int]:
    # Only used on a single top-level integer value in this test's payload.
    initial = data[offset]
    info = initial & 0x1F
    offset += 1
    if info < 24:
        return None, offset
    raise AssertionError("unexpected multi-byte value in test payload")


def test_roundtrip_nested_structure() -> None:
    value = {
        "a": [1, 2, {"b": None, "aa": True}],
        "z": "hello world",
        "bytes": bytes([0, 1, 2, 255]),
    }
    encoded = encode(value)
    assert decode(encoded) == value
    assert encode(decode(encoded)) == encoded


def test_decode_rejects_non_minimal_integer_length() -> None:
    # 0x18 0x05 encodes 5 using the 1-byte-length form, but 5 fits in the
    # immediate 0-23 range and canonical CBOR requires the shortest form.
    with pytest.raises(CborDecodeError):
        decode(bytes([0x18, 0x05]))


def test_decode_rejects_indefinite_length() -> None:
    # 0x9f is an indefinite-length array head; canonical CBOR never uses it.
    with pytest.raises(CborDecodeError):
        decode(bytes([0x9F, 0xFF]))


def test_decode_rejects_float() -> None:
    # 0xfb is a major-type-7 IEEE-754 double; the kernel-record grammar has
    # no floats.
    with pytest.raises(CborDecodeError):
        decode(bytes([0xFB, 0, 0, 0, 0, 0, 0, 0, 0]))


def test_decode_rejects_tag() -> None:
    # 0xc0 is a major-type-6 tag (tag 0, date/time string); tags are not
    # part of the kernel-record grammar.
    with pytest.raises(CborDecodeError):
        decode(bytes([0xC0, 0x60]))


def test_decode_rejects_out_of_canonical_order_map_keys() -> None:
    # Map with keys "z" (len 1) then "aa" (len 2) is fine (length-ascending),
    # but two keys of the same length out of lexicographic order must be
    # rejected: {"b": 1, "a": 2} is non-canonical (should be a, b).
    encoded = bytes(
        [
            0xA2,  # map(2)
            0x61,
            ord("b"),
            0x01,
            0x61,
            ord("a"),
            0x02,
        ]
    )
    with pytest.raises(CborDecodeError):
        decode(encoded)


def test_decode_rejects_trailing_bytes() -> None:
    with pytest.raises(CborDecodeError):
        decode(encode(1) + b"\x00")


def test_decode_rejects_duplicate_map_keys() -> None:
    encoded = bytes([0xA2, 0x61, ord("a"), 0x01, 0x61, ord("a"), 0x02])
    with pytest.raises(CborDecodeError):
        decode(encoded)


def test_encode_rejects_non_string_map_key() -> None:
    with pytest.raises(CborEncodeError):
        encode({1: "value"})
