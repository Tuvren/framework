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
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	kernel "github.com/tuvren/framework/go/kernel"
)

// fixtureDir is the authority location for the deterministic kernel-record
// fixtures: spec/kernel/... is machine-readable authority per
// docs/KrakenKernelSpecification.md and the repository conformance
// guardrails. Tests read it directly; they never derive canonical bytes by
// eyeballing the Rust or TypeScript ports.
const fixtureDir = "../../spec/conformance/kernel/fixtures"

// kernelProtocolFixtures lists every kernel-protocol-*.json fixture that
// carries the deterministic-hashing/schema-roundtrip oracle fields
// (rawOpaqueBytes*, turnTreeSchemaRecord*, turnNodeIdentityRecord*).
// kernel-protocol-logical.json intentionally has a different shape (it
// backs the kernel.logical.* checks, out of scope for this milestone) and
// is excluded.
var kernelProtocolFixtures = []string{
	"kernel-protocol-deterministic.json",
	"kernel-protocol-empty-bytes.json",
	"kernel-protocol-single-byte.json",
	"kernel-protocol-all-zero-bytes.json",
	"kernel-protocol-all-ones-bytes.json",
	"kernel-protocol-large-bytes.json",
	"kernel-protocol-multi-path-schema.json",
	"kernel-protocol-all-single-paths-schema.json",
	"kernel-protocol-all-ordered-paths-schema.json",
	"kernel-protocol-with-prev-turn.json",
	"kernel-protocol-with-event-hash.json",
	"kernel-protocol-staged-result-failed.json",
	"kernel-protocol-staged-result-interrupted.json",
	"kernel-protocol-many-staged-results.json",
	"kernel-protocol-deep-path-schema.json",
	"kernel-protocol-non-utf8-bytes.json",
	"kernel-protocol-zero-turn-tree-hash.json",
	"kernel-protocol-mixed-status-staged-results.json",
}

type deterministicFixture struct {
	RawOpaqueBytes                  []byte
	RawOpaqueBytesSha256Hex         string
	TurnNodeIdentityRecord          any // decoded with UseNumber via json.Number
	TurnNodeIdentityRecordCborHex   string
	TurnNodeIdentityRecordSha256Hex string
	TurnTreeSchemaRecord            any
	TurnTreeSchemaRecordCborHex     string
	TurnTreeSchemaRecordSha256Hex   string
}

func loadFixture(t *testing.T, name string) deterministicFixture {
	t.Helper()

	path := filepath.Join(fixtureDir, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var top map[string]any
	if err := decoder.Decode(&top); err != nil {
		t.Fatalf("decode fixture %s: %v", path, err)
	}

	fixture := deterministicFixture{
		TurnNodeIdentityRecord:          top["turnNodeIdentityRecord"],
		TurnNodeIdentityRecordCborHex:   top["turnNodeIdentityRecordCborHex"].(string),
		TurnNodeIdentityRecordSha256Hex: top["turnNodeIdentityRecordSha256Hex"].(string),
		TurnTreeSchemaRecord:            top["turnTreeSchemaRecord"],
		TurnTreeSchemaRecordCborHex:     top["turnTreeSchemaRecordCborHex"].(string),
		TurnTreeSchemaRecordSha256Hex:   top["turnTreeSchemaRecordSha256Hex"].(string),
		RawOpaqueBytesSha256Hex:         top["rawOpaqueBytesSha256Hex"].(string),
	}

	rawBytesJSON := top["rawOpaqueBytes"].([]any)
	rawBytes := make([]byte, len(rawBytesJSON))
	for i, v := range rawBytesJSON {
		n, err := v.(json.Number).Int64()
		if err != nil {
			t.Fatalf("fixture %s rawOpaqueBytes[%d] is not an integer: %v", path, i, err)
		}
		rawBytes[i] = byte(n)
	}
	fixture.RawOpaqueBytes = rawBytes

	return fixture
}

// normalizeJSON round-trips a value through Marshal/Unmarshal(UseNumber) so
// values built two different ways (a Go int64 from RecordToJSON vs a
// json.Number parsed straight from a fixture file) compare equal by
// structure rather than by Go type identity.
func normalizeJSON(t *testing.T, value any) any {
	t.Helper()

	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal for normalization: %v", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		t.Fatalf("unmarshal for normalization: %v", err)
	}
	return normalized
}

func TestFixtures_DeterministicHashesAndCanonicalEncoding(t *testing.T) {
	for _, name := range kernelProtocolFixtures {
		t.Run(name, func(t *testing.T) {
			fixture := loadFixture(t, name)

			// (a) canonical CBOR bytes match the fixture's committed hex,
			// for both record families, when encoding directly from the
			// fixture's JSON record (not from the pre-encoded hex).
			schemaRecord, err := kernel.RecordFromJSON(fixture.TurnTreeSchemaRecord)
			if err != nil {
				t.Fatalf("turnTreeSchemaRecord -> Record: %v", err)
			}
			schemaBytes, err := kernel.EncodeCanonical(schemaRecord)
			if err != nil {
				t.Fatalf("encode turnTreeSchemaRecord: %v", err)
			}
			if got := hex.EncodeToString(schemaBytes); got != fixture.TurnTreeSchemaRecordCborHex {
				t.Errorf("turnTreeSchemaRecord canonical CBOR mismatch:\n got: %s\nwant: %s", got, fixture.TurnTreeSchemaRecordCborHex)
			}

			nodeRecord, err := kernel.RecordFromJSON(fixture.TurnNodeIdentityRecord)
			if err != nil {
				t.Fatalf("turnNodeIdentityRecord -> Record: %v", err)
			}
			nodeBytes, err := kernel.EncodeCanonical(nodeRecord)
			if err != nil {
				t.Fatalf("encode turnNodeIdentityRecord: %v", err)
			}
			if got := hex.EncodeToString(nodeBytes); got != fixture.TurnNodeIdentityRecordCborHex {
				t.Errorf("turnNodeIdentityRecord canonical CBOR mismatch:\n got: %s\nwant: %s", got, fixture.TurnNodeIdentityRecordCborHex)
			}

			// (b) SHA-256 hex matches all three *Sha256Hex fields.
			if got := kernel.HashBytesToHex(fixture.RawOpaqueBytes); got != fixture.RawOpaqueBytesSha256Hex {
				t.Errorf("rawOpaqueBytes hash mismatch: got %s want %s", got, fixture.RawOpaqueBytesSha256Hex)
			}
			if got, err := kernel.HashRecord(schemaRecord); err != nil {
				t.Errorf("hash turnTreeSchemaRecord: %v", err)
			} else if got != fixture.TurnTreeSchemaRecordSha256Hex {
				t.Errorf("turnTreeSchemaRecord hash mismatch: got %s want %s", got, fixture.TurnTreeSchemaRecordSha256Hex)
			}
			if got, err := kernel.HashRecord(nodeRecord); err != nil {
				t.Errorf("hash turnNodeIdentityRecord: %v", err)
			} else if got != fixture.TurnNodeIdentityRecordSha256Hex {
				t.Errorf("turnNodeIdentityRecord hash mismatch: got %s want %s", got, fixture.TurnNodeIdentityRecordSha256Hex)
			}

			// (c) decode(hex) -> record -> encode == same bytes.
			schemaHexBytes, err := hex.DecodeString(fixture.TurnTreeSchemaRecordCborHex)
			if err != nil {
				t.Fatalf("decode fixture schema hex: %v", err)
			}
			decodedSchema, err := kernel.DecodeCanonical(schemaHexBytes)
			if err != nil {
				t.Fatalf("DecodeCanonical(turnTreeSchemaRecordCborHex): %v", err)
			}
			reencodedSchema, err := kernel.EncodeCanonical(decodedSchema)
			if err != nil {
				t.Fatalf("re-encode decoded schema: %v", err)
			}
			if !bytes.Equal(reencodedSchema, schemaHexBytes) {
				t.Errorf("turnTreeSchemaRecord decode->encode round trip changed bytes")
			}

			nodeHexBytes, err := hex.DecodeString(fixture.TurnNodeIdentityRecordCborHex)
			if err != nil {
				t.Fatalf("decode fixture node hex: %v", err)
			}
			decodedNode, err := kernel.DecodeCanonical(nodeHexBytes)
			if err != nil {
				t.Fatalf("DecodeCanonical(turnNodeIdentityRecordCborHex): %v", err)
			}
			reencodedNode, err := kernel.EncodeCanonical(decodedNode)
			if err != nil {
				t.Fatalf("re-encode decoded node: %v", err)
			}
			if !bytes.Equal(reencodedNode, nodeHexBytes) {
				t.Errorf("turnNodeIdentityRecord decode->encode round trip changed bytes")
			}

			// (d) record JSON round-trip deep-equals the fixture record JSON.
			schemaJSON, err := kernel.RecordToJSON(decodedSchema)
			if err != nil {
				t.Fatalf("turnTreeSchemaRecord -> JSON: %v", err)
			}
			if !reflect.DeepEqual(normalizeJSON(t, schemaJSON), normalizeJSON(t, fixture.TurnTreeSchemaRecord)) {
				t.Errorf("turnTreeSchemaRecord JSON round trip mismatch:\n got: %#v\nwant: %#v", schemaJSON, fixture.TurnTreeSchemaRecord)
			}

			nodeJSON, err := kernel.RecordToJSON(decodedNode)
			if err != nil {
				t.Fatalf("turnNodeIdentityRecord -> JSON: %v", err)
			}
			if !reflect.DeepEqual(normalizeJSON(t, nodeJSON), normalizeJSON(t, fixture.TurnNodeIdentityRecord)) {
				t.Errorf("turnNodeIdentityRecord JSON round trip mismatch:\n got: %#v\nwant: %#v", nodeJSON, fixture.TurnNodeIdentityRecord)
			}
		})
	}
}
