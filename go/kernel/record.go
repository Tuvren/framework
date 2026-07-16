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

// Record is the canonical kernel-record sum type defined by
// spec/kernel/cddl/kernel-records.cddl:
//
//	kernel-record = null / bool / js-safe-int / tstr / bytes / kernel-array / kernel-map
//
// It intentionally excludes CBOR floats and tags; only the seven concrete
// types below implement it.
type Record interface {
	// recordMarker is unexported so Record stays a closed sum type: only the
	// variants declared in this file can satisfy it.
	recordMarker()
}

// RecordNull is the kernel-record null variant.
type RecordNull struct{}

// RecordBool is the kernel-record bool variant.
type RecordBool bool

// RecordInt is the kernel-record js-safe-int variant. Values must stay
// within [MinSafeInteger, MaxSafeInteger]; encoding and decoding both
// enforce that bound.
type RecordInt int64

// RecordText is the kernel-record tstr variant.
type RecordText string

// RecordBytes is the kernel-record bytes variant.
type RecordBytes []byte

// RecordArray is the kernel-record kernel-array variant.
type RecordArray []Record

// RecordMap is the kernel-record kernel-map variant. Key order carries no
// meaning: canonical encoding always sorts entries by their encoded key
// bytes, so any two maps with the same key/value pairs encode identically
// regardless of Go map iteration order.
type RecordMap map[string]Record

func (RecordNull) recordMarker()  {}
func (RecordBool) recordMarker()  {}
func (RecordInt) recordMarker()   {}
func (RecordText) recordMarker()  {}
func (RecordBytes) recordMarker() {}
func (RecordArray) recordMarker() {}
func (RecordMap) recordMarker()   {}

// MinSafeInteger and MaxSafeInteger bound the CDDL js-safe-int range:
// -9007199254740991..9007199254740991 (Number.MAX_SAFE_INTEGER family, the
// shared runtime scalar every kernel port must agree on).
const (
	MinSafeInteger int64 = -9_007_199_254_740_991
	MaxSafeInteger int64 = 9_007_199_254_740_991
)
