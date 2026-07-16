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
	"encoding/json"
	"fmt"
)

// RecordFromJSON converts a generic JSON value (as produced by a
// json.Decoder with UseNumber enabled, so integers arrive as json.Number
// rather than float64) into a Record. JSON numbers must parse as base-10
// integers within the js-safe-int range; JSON's normal object/array/string
// forms map onto RecordMap/RecordArray/RecordText directly. There is no
// dedicated JSON shape for RecordBytes in this conversion because none of
// the kernel-protocol record families (TurnTreeSchema, TurnNode identity)
// carry a bytes-typed field; callers that need raw bytes read them from
// their own JSON field (for example a byte-value array) directly.
func RecordFromJSON(value any) (Record, error) {
	switch v := value.(type) {
	case nil:
		return RecordNull{}, nil
	case bool:
		return RecordBool(v), nil
	case json.Number:
		integer, err := v.Int64()
		if err != nil {
			return nil, fmt.Errorf("kernel record from JSON: %q is not a base-10 integer: %w", v.String(), err)
		}
		if integer < MinSafeInteger || integer > MaxSafeInteger {
			return nil, fmt.Errorf("kernel record from JSON: integer %d is outside the js-safe-int range [%d, %d]", integer, MinSafeInteger, MaxSafeInteger)
		}
		return RecordInt(integer), nil
	case string:
		return RecordText(v), nil
	case []any:
		elements := make(RecordArray, 0, len(v))
		for _, item := range v {
			element, err := RecordFromJSON(item)
			if err != nil {
				return nil, err
			}
			elements = append(elements, element)
		}
		return elements, nil
	case map[string]any:
		result := make(RecordMap, len(v))
		for key, item := range v {
			element, err := RecordFromJSON(item)
			if err != nil {
				return nil, err
			}
			result[key] = element
		}
		return result, nil
	default:
		return nil, fmt.Errorf("kernel record from JSON: unsupported JSON value type %T", value)
	}
}

// RecordToJSON converts a Record back into a generic JSON-marshalable value.
// RecordInt values stay Go int64 (encoding/json emits them as JSON integer
// literals, not float64, so js-safe-int fidelity survives the round trip).
// RecordBytes values become a []int64 of unsigned byte values, mirroring how
// the TypeScript and Rust kernel ports represent opaque bytes at the JSON
// boundary.
func RecordToJSON(record Record) (any, error) {
	switch v := record.(type) {
	case RecordNull:
		return nil, nil
	case RecordBool:
		return bool(v), nil
	case RecordInt:
		return int64(v), nil
	case RecordText:
		return string(v), nil
	case RecordBytes:
		out := make([]int64, len(v))
		for i, b := range v {
			out[i] = int64(b)
		}
		return out, nil
	case RecordArray:
		out := make([]any, len(v))
		for i, element := range v {
			converted, err := RecordToJSON(element)
			if err != nil {
				return nil, err
			}
			out[i] = converted
		}
		return out, nil
	case RecordMap:
		out := make(map[string]any, len(v))
		for key, element := range v {
			converted, err := RecordToJSON(element)
			if err != nil {
				return nil, err
			}
			out[key] = converted
		}
		return out, nil
	default:
		return nil, fmt.Errorf("kernel record to JSON: unsupported record type %T", record)
	}
}
