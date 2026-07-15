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

package kernel

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"
	"unicode/utf8"
)

// EncodeCanonical serializes a Record into deterministic CBOR bytes per RFC
// 8949's core deterministic encoding requirements as scoped by
// spec/kernel/cddl/kernel-records.cddl: definite lengths everywhere, the
// shortest-possible integer head for every length and integer value, and
// map entries sorted by their own encoded key bytes (which, for the
// short text keys this record family uses, amounts to shortest-key-first
// and then byte-lexicographic).
func EncodeCanonical(record Record) ([]byte, error) {
	return appendRecord(nil, record)
}

// DecodeCanonical parses CBOR bytes into a Record and rejects any input that
// is not already the unique canonical encoding of the record it describes.
// Strictness is enforced by re-encoding the decoded record and requiring a
// byte-for-byte match against the input: this catches non-minimal integer
// heads, out-of-order map keys, and duplicate map keys without needing a
// second bespoke validation pass. Floats, tags, and indefinite-length items
// are rejected directly during decoding because this record family has no
// representation for them at all.
func DecodeCanonical(data []byte) (Record, error) {
	record, next, err := decodeRecord(data, 0)
	if err != nil {
		return nil, err
	}
	if next != len(data) {
		return nil, fmt.Errorf("kernel record decode: %d trailing byte(s) after top-level value", len(data)-next)
	}

	canonical, err := EncodeCanonical(record)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(canonical, data) {
		return nil, fmt.Errorf("kernel record decode: input is not the canonical deterministic CBOR encoding of its own value")
	}

	return record, nil
}

// --- encoding ---

func appendRecord(buf []byte, record Record) ([]byte, error) {
	switch value := record.(type) {
	case nil:
		return nil, fmt.Errorf("kernel record encode: record must not be a nil interface")
	case RecordNull:
		return append(buf, 0xf6), nil
	case RecordBool:
		if value {
			return append(buf, 0xf5), nil
		}
		return append(buf, 0xf4), nil
	case RecordInt:
		return appendInt(buf, int64(value))
	case RecordText:
		return appendTextBytes(buf, []byte(value)), nil
	case RecordBytes:
		buf = appendHead(buf, 2, uint64(len(value)))
		return append(buf, value...), nil
	case RecordArray:
		buf = appendHead(buf, 4, uint64(len(value)))
		for _, element := range value {
			var err error
			buf, err = appendRecord(buf, element)
			if err != nil {
				return nil, err
			}
		}
		return buf, nil
	case RecordMap:
		return appendMap(buf, value)
	default:
		return nil, fmt.Errorf("kernel record encode: unsupported record type %T", record)
	}
}

func appendInt(buf []byte, value int64) ([]byte, error) {
	if value < MinSafeInteger || value > MaxSafeInteger {
		return nil, fmt.Errorf("kernel record encode: integer %d is outside the js-safe-int range [%d, %d]", value, MinSafeInteger, MaxSafeInteger)
	}
	if value >= 0 {
		return appendHead(buf, 0, uint64(value)), nil
	}
	return appendHead(buf, 1, uint64(-1-value)), nil
}

func appendTextBytes(buf []byte, text []byte) []byte {
	buf = appendHead(buf, 3, uint64(len(text)))
	return append(buf, text...)
}

type mapEntry struct {
	keyBytes   []byte
	valueBytes []byte
}

func appendMap(buf []byte, value RecordMap) ([]byte, error) {
	entries := make([]mapEntry, 0, len(value))
	for key, element := range value {
		keyBytes := appendTextBytes(nil, []byte(key))
		valueBytes, err := appendRecord(nil, element)
		if err != nil {
			return nil, err
		}
		entries = append(entries, mapEntry{keyBytes: keyBytes, valueBytes: valueBytes})
	}

	// RFC 8949 deterministic encoding orders map entries by their own
	// encoded key bytes, not by the source language's native string
	// ordering. Comparing the encoded bytes handles the length-prefix rule
	// automatically for every key length, not just the short keys this
	// record family happens to use.
	sort.Slice(entries, func(i, j int) bool {
		return bytes.Compare(entries[i].keyBytes, entries[j].keyBytes) < 0
	})

	buf = appendHead(buf, 5, uint64(len(entries)))
	for _, entry := range entries {
		buf = append(buf, entry.keyBytes...)
		buf = append(buf, entry.valueBytes...)
	}
	return buf, nil
}

// appendHead writes a CBOR major-type/argument head using the shortest
// encoding that represents val, per RFC 8949's deterministic encoding rule.
func appendHead(buf []byte, majorType byte, val uint64) []byte {
	prefix := majorType << 5
	switch {
	case val < 24:
		return append(buf, prefix|byte(val))
	case val <= 0xff:
		return append(buf, prefix|24, byte(val))
	case val <= 0xffff:
		buf = append(buf, prefix|25)
		return binary.BigEndian.AppendUint16(buf, uint16(val))
	case val <= 0xffffffff:
		buf = append(buf, prefix|26)
		return binary.BigEndian.AppendUint32(buf, uint32(val))
	default:
		buf = append(buf, prefix|27)
		return binary.BigEndian.AppendUint64(buf, val)
	}
}

// --- decoding ---

// maxSafeNegOffset bounds the major-type-1 (negative integer) argument so
// the decoded value -1-n stays within MinSafeInteger.
const maxSafeNegOffset = uint64(-(MinSafeInteger + 1))

// maxDecodeDepth caps the recursion depth decodeRecord will follow through
// nested arrays and maps. Kernel records never need anything close to this
// deep a nesting; the cap exists purely to turn adversarial deeply-nested
// input into a normal decode error instead of a stack-exhaustion crash.
const maxDecodeDepth = 512

func decodeRecord(data []byte, i int) (Record, int, error) {
	return decodeRecordAtDepth(data, i, 0)
}

func decodeRecordAtDepth(data []byte, i int, depth int) (Record, int, error) {
	if depth > maxDecodeDepth {
		return nil, i, fmt.Errorf("kernel record decode: nesting depth exceeds the maximum of %d", maxDecodeDepth)
	}

	majorType, additionalInfo, val, next, err := decodeHead(data, i)
	if err != nil {
		return nil, i, err
	}

	switch majorType {
	case 0: // unsigned integer
		if val > uint64(MaxSafeInteger) {
			return nil, i, fmt.Errorf("kernel record decode: unsigned integer %d exceeds js-safe-int range", val)
		}
		return RecordInt(int64(val)), next, nil
	case 1: // negative integer
		if val > maxSafeNegOffset {
			return nil, i, fmt.Errorf("kernel record decode: negative integer argument %d exceeds js-safe-int range", val)
		}
		return RecordInt(-1 - int64(val)), next, nil
	case 2: // byte string
		end := next + int(val)
		if val > uint64(len(data)-next) || end < next {
			return nil, i, fmt.Errorf("kernel record decode: byte string length %d exceeds remaining input", val)
		}
		out := make([]byte, val)
		copy(out, data[next:end])
		return RecordBytes(out), end, nil
	case 3: // text string
		end := next + int(val)
		if val > uint64(len(data)-next) || end < next {
			return nil, i, fmt.Errorf("kernel record decode: text string length %d exceeds remaining input", val)
		}
		text := data[next:end]
		if !utf8.Valid(text) {
			return nil, i, fmt.Errorf("kernel record decode: text string is not valid UTF-8")
		}
		return RecordText(string(text)), end, nil
	case 4: // array
		// val is an untrusted length header: a 9-byte input can claim
		// 2^64-1 elements. Every element needs at least one input byte, so
		// clamp the pre-allocation hint to the remaining input length; this
		// turns a malicious length claim into a normal decode error (the
		// loop below runs out of input long before val iterations) instead
		// of an out-of-memory panic from over-eager allocation.
		if val > uint64(len(data)-next) {
			return nil, i, fmt.Errorf("kernel record decode: array length %d exceeds remaining input", val)
		}
		elements := make(RecordArray, 0, val)
		cursor := next
		for count := uint64(0); count < val; count++ {
			var element Record
			var err error
			element, cursor, err = decodeRecordAtDepth(data, cursor, depth+1)
			if err != nil {
				return nil, i, err
			}
			elements = append(elements, element)
		}
		return elements, cursor, nil
	case 5: // map
		// Same untrusted-length guard as the array case above: each map
		// entry needs at least a 1-byte key head and a 1-byte value, so two
		// bytes is the minimum remaining-input cost per claimed entry.
		if val > uint64(len(data)-next)/2 {
			return nil, i, fmt.Errorf("kernel record decode: map length %d exceeds remaining input", val)
		}
		result := make(RecordMap, val)
		cursor := next
		for count := uint64(0); count < val; count++ {
			keyMajorType, _, keyVal, afterKeyHead, err := decodeHead(data, cursor)
			if err != nil {
				return nil, i, err
			}
			if keyMajorType != 3 {
				return nil, i, fmt.Errorf("kernel record decode: map keys must be text strings")
			}
			keyEnd := afterKeyHead + int(keyVal)
			if keyVal > uint64(len(data)-afterKeyHead) || keyEnd < afterKeyHead {
				return nil, i, fmt.Errorf("kernel record decode: map key length %d exceeds remaining input", keyVal)
			}
			keyText := data[afterKeyHead:keyEnd]
			if !utf8.Valid(keyText) {
				return nil, i, fmt.Errorf("kernel record decode: map key is not valid UTF-8")
			}

			var value Record
			cursor, err = keyEnd, nil
			value, cursor, err = decodeRecordAtDepth(data, cursor, depth+1)
			if err != nil {
				return nil, i, err
			}
			result[string(keyText)] = value
		}
		return result, cursor, nil
	case 6: // tag
		return nil, i, fmt.Errorf("kernel record decode: kernel records must not use CBOR tags")
	case 7: // simple values and floats
		switch additionalInfo {
		case 20:
			return RecordBool(false), next, nil
		case 21:
			return RecordBool(true), next, nil
		case 22:
			return RecordNull{}, next, nil
		case 25, 26, 27:
			return nil, i, fmt.Errorf("kernel records must not use CBOR floats")
		default:
			return nil, i, fmt.Errorf("kernel record decode: unsupported simple value (additional info %d)", additionalInfo)
		}
	default:
		return nil, i, fmt.Errorf("kernel record decode: unsupported major type %d", majorType)
	}
}

// decodeHead reads one CBOR major-type/argument head starting at data[i] and
// returns the major type, the raw 5-bit additional-info field, the decoded
// argument value, and the index just past the head. Reserved additional
// info values (28-30) and indefinite-length markers (31) are rejected here
// because this record family has no representation for either.
func decodeHead(data []byte, i int) (majorType byte, additionalInfo byte, val uint64, next int, err error) {
	if i >= len(data) {
		return 0, 0, 0, i, fmt.Errorf("kernel record decode: unexpected end of input reading a value head")
	}

	first := data[i]
	majorType = first >> 5
	additionalInfo = first & 0x1f
	i++

	switch {
	case additionalInfo < 24:
		val = uint64(additionalInfo)
	case additionalInfo == 24:
		if i+1 > len(data) {
			return 0, 0, 0, i, fmt.Errorf("kernel record decode: truncated 1-byte length argument")
		}
		val = uint64(data[i])
		i++
	case additionalInfo == 25:
		if i+2 > len(data) {
			return 0, 0, 0, i, fmt.Errorf("kernel record decode: truncated 2-byte length argument")
		}
		val = uint64(binary.BigEndian.Uint16(data[i : i+2]))
		i += 2
	case additionalInfo == 26:
		if i+4 > len(data) {
			return 0, 0, 0, i, fmt.Errorf("kernel record decode: truncated 4-byte length argument")
		}
		val = uint64(binary.BigEndian.Uint32(data[i : i+4]))
		i += 4
	case additionalInfo == 27:
		if i+8 > len(data) {
			return 0, 0, 0, i, fmt.Errorf("kernel record decode: truncated 8-byte length argument")
		}
		val = binary.BigEndian.Uint64(data[i : i+8])
		i += 8
	case additionalInfo == 31:
		return 0, 0, 0, i, fmt.Errorf("kernel record decode: indefinite-length CBOR items are not supported")
	default: // 28, 29, 30
		return 0, 0, 0, i, fmt.Errorf("kernel record decode: reserved additional information value %d", additionalInfo)
	}

	return majorType, additionalInfo, val, i, nil
}
