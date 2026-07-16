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

// Command kernel-conformance-adapter is the Go kernel conformance adapter.
//
// It speaks the Tuvren conformance adapter protocol (JSON-RPC 2.0 request and
// response framing over line-delimited stdio, see
// tools/conformance/adapter-protocol/protocol.md) so the shared conformance
// engine (tools/conformance/harness/run.ts) can drive the Go kernel port the
// same way it drives the TypeScript and Rust ports. Operation handlers are
// wired through the dispatch table in dispatch.go, split by concern across
// the operations*.go files; an operation name outside that table reports
// adapter_operation_not_implemented.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

const adapterID = "go-kernel"

// jsonRPCRequest is one line of adapter stdin: a JSON-RPC 2.0 request frame.
type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// adapterErrorEnvelope is the Tuvren ErrorEnvelope shape carried by the
// JSON-RPC response's error member. It intentionally is not a third-party
// JSON-RPC numeric error object; see protocol.md.
type adapterErrorEnvelope struct {
	Code    string                `json:"code"`
	Message string                `json:"message"`
	Details json.RawMessage       `json:"details,omitempty"`
	Cause   *adapterErrorEnvelope `json:"cause,omitempty"`
}

// adapterCapabilities is the initialize response shape.
type adapterCapabilities struct {
	AdapterID    string   `json:"adapterId"`
	Capabilities []string `json:"capabilities"`
	PacketID     string   `json:"packetId"`
	PlanVersion  string   `json:"planVersion"`
}

func main() {
	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			handleLine(writer, line)
			writer.Flush()
		}
		if err != nil {
			if err == io.EOF {
				return
			}
			fmt.Fprintf(os.Stderr, "kernel-conformance-adapter: failed to read stdin: %v\n", err)
			return
		}
	}
}

// handleLine parses and dispatches a single JSON-RPC request line, writing
// exactly one JSON-RPC response line to writer. Diagnostics never go to
// stdout; stdout carries protocol frames only.
func handleLine(writer *bufio.Writer, line string) {
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.UseNumber()

	var request jsonRPCRequest
	if err := decoder.Decode(&request); err != nil {
		writeResponse(writer, nil, nil, &adapterErrorEnvelope{
			Code:    "invalid_json_rpc_request",
			Message: fmt.Sprintf("failed to parse JSON-RPC request: %v", err),
		})
		return
	}

	if request.JSONRPC != "2.0" {
		writeResponse(writer, request.ID, nil, &adapterErrorEnvelope{
			Code:    "invalid_json_rpc_request",
			Message: "request jsonrpc must be 2.0",
		})
		return
	}

	result, rpcErr := dispatchMethod(request)
	writeResponse(writer, request.ID, result, rpcErr)
}

// dispatchMethod routes one JSON-RPC request to its protocol method handler.
// Unknown methods return an adapter_method_not_implemented error envelope
// rather than a numeric JSON-RPC error code.
func dispatchMethod(request jsonRPCRequest) (any, *adapterErrorEnvelope) {
	switch request.Method {
	case "initialize":
		return handleInitialize(request.Params)
	case "dispatch":
		return handleDispatch(request.Params)
	case "events":
		return []any{}, nil
	case "createInstance", "inspectState", "destroyInstance", "shutdown":
		return nil, nil
	default:
		return nil, &adapterErrorEnvelope{
			Code:    "adapter_method_not_implemented",
			Message: fmt.Sprintf("unsupported adapter method %s", request.Method),
		}
	}
}

func handleInitialize(rawParams json.RawMessage) (any, *adapterErrorEnvelope) {
	var params struct {
		PacketID    string `json:"packetId"`
		PlanVersion string `json:"planVersion"`
	}
	if len(rawParams) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(rawParams))
		decoder.UseNumber()
		if err := decoder.Decode(&params); err != nil {
			return nil, &adapterErrorEnvelope{
				Code:    "invalid_adapter_request",
				Message: fmt.Sprintf("failed to parse initialize params: %v", err),
			}
		}
	}

	if params.PacketID == "" {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_adapter_request",
			Message: "params.packetId must be a non-empty string",
		}
	}
	if params.PlanVersion == "" {
		return nil, &adapterErrorEnvelope{
			Code:    "invalid_adapter_request",
			Message: "params.planVersion must be a non-empty string",
		}
	}

	return adapterCapabilities{
		AdapterID:    adapterID,
		Capabilities: capabilities(),
		PacketID:     params.PacketID,
		PlanVersion:  params.PlanVersion,
	}, nil
}

// operationOutcome mirrors the protocol schema's OperationOutcome union:
// either {kind:"result", value} or {kind:"error", error}.
type operationOutcome struct {
	Kind  string                `json:"kind"`
	Value any                   `json:"value,omitempty"`
	Error *adapterErrorEnvelope `json:"error,omitempty"`
}

func handleDispatch(rawParams json.RawMessage) (any, *adapterErrorEnvelope) {
	var params struct {
		Operation string          `json:"operation"`
		Input     json.RawMessage `json:"input"`
	}
	if len(rawParams) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(rawParams))
		decoder.UseNumber()
		if err := decoder.Decode(&params); err != nil {
			return nil, &adapterErrorEnvelope{
				Code:    "invalid_adapter_request",
				Message: fmt.Sprintf("failed to parse dispatch params: %v", err),
			}
		}
	}

	return dispatchOperation(params.Operation, params.Input), nil
}

func writeResponse(writer *bufio.Writer, id json.RawMessage, result any, rpcErr *adapterErrorEnvelope) {
	frame := map[string]any{
		"jsonrpc": "2.0",
		"id":      rawOrNull(id),
	}
	if rpcErr != nil {
		frame["error"] = rpcErr
	} else {
		frame["result"] = result
	}

	encoded, err := json.Marshal(frame)
	if err != nil {
		// A response frame that fails to marshal must still produce exactly
		// one line on stdout: the harness matches responses to requests by
		// id, and writing nothing at all here would hang that request id
		// forever instead of failing it. Hand-build a minimal JSON-RPC
		// error frame with fmt (not encoding/json) so the fallback itself
		// cannot fail the same way — id is re-emitted as raw JSON (it was
		// already validated as well-formed JSON by the request decode that
		// produced it, or is the literal "null" when absent). The message
		// is NOT embedded via fmt's %q: Go-syntax backslash escaping is not
		// always valid JSON string escaping (%q emits \xNN / \uNNNN forms
		// for some non-printable bytes that JSON does not accept in that
		// form), so it is marshalled on its own with encoding/json instead
		// — marshalling a plain string cannot itself fail — and the
		// resulting JSON string literal is spliced into the hand-built
		// frame. The error code matches the Python adapter's
		// adapter_response_serialization_failed byte-for-byte.
		fmt.Fprintf(os.Stderr, "kernel-conformance-adapter: failed to encode response: %v\n", err)
		idLiteral := "null"
		if raw := rawOrNull(id); raw != nil {
			idLiteral = string(raw.(json.RawMessage))
		}
		messageJSON, msgErr := json.Marshal(fmt.Sprintf("failed to encode response frame: %v", err))
		if msgErr != nil {
			messageJSON = []byte(`"failed to encode response frame"`)
		}
		fallback := fmt.Sprintf(
			`{"jsonrpc":"2.0","id":%s,"error":{"code":"adapter_response_serialization_failed","message":%s}}`,
			idLiteral, messageJSON,
		)
		writer.WriteString(fallback)
		writer.WriteByte('\n')
		return
	}

	writer.Write(encoded)
	writer.WriteByte('\n')
}

func rawOrNull(id json.RawMessage) any {
	if len(id) == 0 {
		return nil
	}
	return json.RawMessage(id)
}
