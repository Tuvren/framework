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

// Regression coverage for writeResponse's hand-built JSON-RPC fallback
// frame (main.go): when the normal encoding/json.Marshal of the response
// frame fails, writeResponse must still emit exactly one well-formed JSON
// line, using the same error code the Python adapter's equivalent fallback
// uses (adapter_response_serialization_failed) and a strictly JSON-safe
// message (marshalled with encoding/json rather than spliced in via fmt's
// %q, which is not guaranteed to produce valid JSON string escaping for
// every byte it can emit).
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestWriteResponse_SerializationFailureFallsBackToJSONSafeFrame(t *testing.T) {
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	// A channel value cannot be marshalled by encoding/json, forcing
	// writeResponse down its fallback path.
	unmarshalable := map[string]any{"broken": make(chan int)}

	writeResponse(writer, json.RawMessage(`"req-1"`), unmarshalable, nil)
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	line := strings.TrimRight(buf.String(), "\n")
	if strings.Count(buf.String(), "\n") != 1 {
		t.Fatalf("expected exactly one line on the writer, got %q", buf.String())
	}

	var frame struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Error   *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &frame); err != nil {
		t.Fatalf("expected the fallback frame to be valid JSON, got %q: %v", line, err)
	}

	if frame.Error == nil {
		t.Fatalf("expected the fallback frame to carry an error, got %q", line)
	}
	if frame.Error.Code != "adapter_response_serialization_failed" {
		t.Fatalf("expected fallback error code %q, got %q", "adapter_response_serialization_failed", frame.Error.Code)
	}
	if !strings.Contains(frame.Error.Message, "failed to encode response frame") {
		t.Fatalf("expected fallback error message to describe the encode failure, got %q", frame.Error.Message)
	}
	if string(frame.ID) != `"req-1"` {
		t.Fatalf("expected fallback frame to re-emit the request id, got %q", string(frame.ID))
	}
}

// TestWriteResponse_SerializationFailureEscapesNonPrintableBytesAsValidJSON
// proves the fallback message survives content that is exactly the case
// fmt's %q would mis-escape for JSON purposes if it were still used: a
// literal double-quote and backslash pair, which %q would still render as
// valid JSON here, but which motivates using encoding/json.Marshal
// directly (a plain string marshal cannot fail and is unambiguously
// JSON-safe for every byte, printable or not) instead of relying on
// Go-syntax escaping being coincidentally compatible with JSON string
// escaping.
func TestWriteResponse_SerializationFailureEscapesNonPrintableBytesAsValidJSON(t *testing.T) {
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	unmarshalable := map[string]any{"broken": make(chan int)}
	writeResponse(writer, nil, unmarshalable, nil)
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	line := strings.TrimRight(buf.String(), "\n")
	var frame map[string]any
	if err := json.Unmarshal([]byte(line), &frame); err != nil {
		t.Fatalf("expected the fallback frame to be valid JSON even with no request id, got %q: %v", line, err)
	}
	if frame["id"] != nil {
		t.Fatalf("expected a nil request id to fall back to JSON null, got %v", frame["id"])
	}
}
