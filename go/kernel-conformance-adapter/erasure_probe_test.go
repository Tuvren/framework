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

// Milestone M4 coverage for the reclamation erasure-probe operation
// (runErasureProbe in operations_maintenance.go) and the AES-256-GCM
// crypto-shredding internals it relies on, mirroring the coverage intent of
// python/kernel-conformance-adapter/tests/test_erasure_probe.py.
package main

import (
	"bytes"
	"crypto/rand"
	"reflect"
	"testing"
)

// erasureFieldsFromOutcome extracts the operation's projected "erasure"
// observation object from an operationOutcome, failing the test loudly if
// the outcome is not a well-formed result envelope.
func erasureFieldsFromOutcome(t *testing.T, outcome operationOutcome) map[string]any {
	t.Helper()
	if outcome.Kind != "result" {
		t.Fatalf("expected a result outcome, got kind %q (error: %+v)", outcome.Kind, outcome.Error)
	}
	value, ok := outcome.Value.(map[string]any)
	if !ok {
		t.Fatalf("expected outcome.Value to be a map[string]any, got %T", outcome.Value)
	}
	result, ok := value["result"].(map[string]any)
	if !ok {
		t.Fatalf("expected value[\"result\"] to be a map[string]any, got %T", value["result"])
	}
	evidence, ok := value["evidence"].(map[string]any)
	if !ok {
		t.Fatalf("expected value[\"evidence\"] to be a map[string]any, got %T", value["evidence"])
	}
	if !reflect.DeepEqual(result, evidence) {
		t.Fatalf("expected projection's evidence and result to be identical, got result=%+v evidence=%+v", result, evidence)
	}

	erasure, ok := result["erasure"].(map[string]any)
	if !ok {
		t.Fatalf("expected result[\"erasure\"] to be a map[string]any, got %T", result["erasure"])
	}
	return erasure
}

func TestRunErasureProbe_ReportsAllTrue(t *testing.T) {
	erasure := erasureFieldsFromOutcome(t, runErasureProbe(nil))

	want := map[string]any{
		"recoverableBeforeErasure":              true,
		"unrecoverableAfterErasure":             true,
		"lineageStructurallyIntactAfterErasure": true,
	}
	if !reflect.DeepEqual(erasure, want) {
		t.Fatalf("expected erasure observation %+v, got %+v", want, erasure)
	}
}

// TestRunErasureProbe_ReusableAcrossDispatches proves the operation is safe
// to call repeatedly: each dispatch builds its own fresh in-memory Kernel
// and its own random AES-256 key/nonce, so calling twice must not leak
// state or produce a different outcome shape.
func TestRunErasureProbe_ReusableAcrossDispatches(t *testing.T) {
	first := erasureFieldsFromOutcome(t, runErasureProbe(nil))
	second := erasureFieldsFromOutcome(t, runErasureProbe(nil))

	if !reflect.DeepEqual(first, second) {
		t.Fatalf("expected repeated dispatches to report identical erasure observations, got first=%+v second=%+v", first, second)
	}
}

// TestAesGcmEnvelope_RoundtripsBeforeKeyDestruction is a unit-level proof of
// the crypto-shredding primitive the probe relies on: encrypting under a
// real AES-256 key and decrypting with the same key recovers the original
// plaintext exactly.
func TestAesGcmEnvelope_RoundtripsBeforeKeyDestruction(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate key: %v", err)
	}
	plaintext := []byte("sensitive-untrusted-edge-payload")

	envelope, err := aesGcmEnvelope(key, plaintext)
	if err != nil {
		t.Fatalf("aesGcmEnvelope: %v", err)
	}

	decrypted, err := aesGcmOpen(key, envelope)
	if err != nil {
		t.Fatalf("aesGcmOpen with the correct key: %v", err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("expected decrypted plaintext %q, got %q", plaintext, decrypted)
	}
}

// TestAesGcmEnvelope_KeyZeroingSeversRecoverability proves the erasure
// probe's actual crypto-shredding mechanism: overwriting the only key
// reference with zero bytes (the same technique runErasureProbe applies to
// its own key slice after dropping the keyring entry) makes the identical,
// untouched ciphertext genuinely unrecoverable — a real AES-GCM
// authentication-tag failure against the real stored bytes, not a
// short-circuited check against an absent key.
func TestAesGcmEnvelope_KeyZeroingSeversRecoverability(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate key: %v", err)
	}
	plaintext := []byte("sensitive-untrusted-edge-payload")

	envelope, err := aesGcmEnvelope(key, plaintext)
	if err != nil {
		t.Fatalf("aesGcmEnvelope: %v", err)
	}

	// Sanity: recoverable before the key is destroyed.
	if _, err := aesGcmOpen(key, envelope); err != nil {
		t.Fatalf("expected the envelope to be recoverable before key destruction, got error: %v", err)
	}

	// Zero the key's backing array in place, exactly as runErasureProbe does
	// to its own key slice on erasure.
	for i := range key {
		key[i] = 0
	}

	if _, err := aesGcmOpen(key, envelope); err == nil {
		t.Fatalf("expected the envelope to be unrecoverable after key zeroing, got a successful decrypt")
	}
}

// TestAesGcmEnvelope_WrongKeyFailsAuthentication proves aesGcmOpen fails
// closed (a genuine GCM authentication-tag mismatch) against an unrelated
// key, rather than silently returning garbage plaintext.
func TestAesGcmEnvelope_WrongKeyFailsAuthentication(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate key: %v", err)
	}
	wrongKey := make([]byte, 32)
	if _, err := rand.Read(wrongKey); err != nil {
		t.Fatalf("generate wrong key: %v", err)
	}
	plaintext := []byte("sensitive-untrusted-edge-payload")

	envelope, err := aesGcmEnvelope(key, plaintext)
	if err != nil {
		t.Fatalf("aesGcmEnvelope: %v", err)
	}

	if _, err := aesGcmOpen(wrongKey, envelope); err == nil {
		t.Fatalf("expected decrypting with an unrelated key to fail authentication")
	}
}
