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
	"crypto/sha256"
	"encoding/hex"
)

// HashBytesToHex hashes raw opaque bytes directly with SHA-256 and returns
// the lowercase hex digest. This is the kernel spec's §2.3 Hash primitive:
// the content address of a Blob, with no canonical-record wrapping.
func HashBytesToHex(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

// HashRecord computes a record's identity hash: the SHA-256 digest of its
// canonical deterministic CBOR encoding, returned as a lowercase hex
// hash-string (spec/kernel/cddl/kernel-records.cddl's hash-string shape).
func HashRecord(record Record) (string, error) {
	encoded, err := EncodeCanonical(record)
	if err != nil {
		return "", err
	}
	return HashBytesToHex(encoded), nil
}
