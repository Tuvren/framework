// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package kernel_test

import (
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

func TestDecodeCanonical_RejectsNonMinimalIntegerHead(t *testing.T) {
	// 0x18 0x05 encodes the integer 5 using the 1-byte-argument form
	// (additional info 24), even though 5 fits in the immediate 5-bit
	// argument (0x05). The canonical form is the single byte 0x05; this
	// input round-trips to different bytes and must be rejected.
	nonMinimal := []byte{0x18, 0x05}
	if _, err := kernel.DecodeCanonical(nonMinimal); err == nil {
		t.Fatal("expected non-minimal integer head to be rejected")
	}
}

func TestDecodeCanonical_RejectsUnsortedMapKeys(t *testing.T) {
	// { "bb": 1, "a": 2 } with keys encoded in file order (longer key
	// first) is well-formed CBOR but not canonical: "a" (1-byte key)
	// sorts before "bb" (2-byte key).
	unsorted := []byte{
		0xa2,                 // map(2)
		0x62, 'b', 'b', 0x01, // "bb": 1
		0x61, 'a', 0x02, // "a": 2
	}
	if _, err := kernel.DecodeCanonical(unsorted); err == nil {
		t.Fatal("expected unsorted map keys to be rejected")
	}
}

func TestDecodeCanonical_RejectsFloat(t *testing.T) {
	// 0xfb + 8 bytes is a double-precision float (1.0).
	floatBytes := []byte{0xfb, 0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	if _, err := kernel.DecodeCanonical(floatBytes); err == nil {
		t.Fatal("expected CBOR float to be rejected")
	}
}

func TestDecodeCanonical_RejectsTag(t *testing.T) {
	// Tag 0 (standard date/time string) wrapping a text string.
	tagged := []byte{0xc0, 0x60}
	if _, err := kernel.DecodeCanonical(tagged); err == nil {
		t.Fatal("expected CBOR tag to be rejected")
	}
}

func TestDecodeCanonical_RejectsIndefiniteLength(t *testing.T) {
	// Indefinite-length array (0x9f) terminated by break (0xff), empty.
	indefinite := []byte{0x9f, 0xff}
	if _, err := kernel.DecodeCanonical(indefinite); err == nil {
		t.Fatal("expected indefinite-length CBOR to be rejected")
	}
}

func TestDecodeCanonical_RejectsTrailingBytes(t *testing.T) {
	// A canonical null (0xf6) followed by a stray extra byte.
	trailing := []byte{0xf6, 0x00}
	if _, err := kernel.DecodeCanonical(trailing); err == nil {
		t.Fatal("expected trailing bytes after the top-level value to be rejected")
	}
}

func TestDecodeCanonical_RejectsIntegerOutsideSafeRange(t *testing.T) {
	// 2^63-1, encoded minimally as an 8-byte unsigned integer, is far
	// outside the js-safe-int range.
	tooLarge := []byte{0x1b, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if _, err := kernel.DecodeCanonical(tooLarge); err == nil {
		t.Fatal("expected an integer outside the js-safe-int range to be rejected")
	}
}

func TestEncodeCanonical_RejectsIntegerOutsideSafeRange(t *testing.T) {
	if _, err := kernel.EncodeCanonical(kernel.RecordInt(kernel.MaxSafeInteger + 1)); err == nil {
		t.Fatal("expected encoding an out-of-range integer to fail")
	}
	if _, err := kernel.EncodeCanonical(kernel.RecordInt(kernel.MinSafeInteger - 1)); err == nil {
		t.Fatal("expected encoding an out-of-range integer to fail")
	}
}

func TestDecodeCanonical_RejectsArrayLengthClaimExceedingInput(t *testing.T) {
	// 0x1b + 8 bytes of 0xff is the 8-byte-argument form of major type 4
	// (array), claiming 2^64-1 elements from a 9-byte input. Pre-allocating
	// a RecordArray with that claimed length as capacity would panic
	// ("makeslice: len out of range") or attempt a multi-exabyte
	// allocation before the per-element loop ever notices the input is
	// exhausted.
	adversarial := []byte{0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if _, err := kernel.DecodeCanonical(adversarial); err == nil {
		t.Fatal("expected an array length claim exceeding the input to be rejected")
	}
}

func TestDecodeCanonical_RejectsMapLengthClaimExceedingInput(t *testing.T) {
	// 0xbb + 8 bytes of 0xff is the 8-byte-argument form of major type 5
	// (map), claiming 2^64-1 entries from a 9-byte input. Pre-allocating a
	// RecordMap with that claimed length would attempt to reserve an
	// enormous bucket table (an effective OOM) before ever reading an
	// entry.
	adversarial := []byte{0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if _, err := kernel.DecodeCanonical(adversarial); err == nil {
		t.Fatal("expected a map length claim exceeding the input to be rejected")
	}
}

func TestDecodeCanonical_RejectsExcessiveNestingDepth(t *testing.T) {
	// 2000 nested single-element arrays, each encoded as 0x81 (array(1))
	// followed eventually by a single null. Without a recursion depth cap
	// this recurses 2000 stack frames deep purely from adversarial input
	// shape.
	const depth = 2000
	encoded := make([]byte, 0, depth+1)
	for i := 0; i < depth; i++ {
		encoded = append(encoded, 0x81) // array(1)
	}
	encoded = append(encoded, 0xf6) // null
	if _, err := kernel.DecodeCanonical(encoded); err == nil {
		t.Fatal("expected excessive nesting depth to be rejected")
	}
}

func TestEncodeDecodeCanonical_RoundTripsAcrossKinds(t *testing.T) {
	record := kernel.RecordMap{
		"z": kernel.RecordNull{},
		"a": kernel.RecordArray{
			kernel.RecordBool(true),
			kernel.RecordBool(false),
			kernel.RecordInt(-1),
			kernel.RecordInt(0),
			kernel.RecordInt(kernel.MaxSafeInteger),
			kernel.RecordInt(kernel.MinSafeInteger),
			kernel.RecordText("hello"),
			kernel.RecordBytes{0x00, 0x01, 0xff},
		},
		"nested": kernel.RecordMap{
			"inner": kernel.RecordText("value"),
		},
	}

	encoded, err := kernel.EncodeCanonical(record)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	decoded, err := kernel.DecodeCanonical(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	reencoded, err := kernel.EncodeCanonical(decoded)
	if err != nil {
		t.Fatalf("re-encode: %v", err)
	}

	if string(reencoded) != string(encoded) {
		t.Fatalf("round trip changed bytes:\n got: %x\nwant: %x", reencoded, encoded)
	}
}
