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
// same way it drives the TypeScript and Rust ports. This milestone (M1)
// wires the kernel.protocol canonical-record core (deterministic hashing,
// schema round-trip, and verdict modify composition) through the dispatch
// table in dispatch.go and operations.go; operations outside that
// capability still report adapter_operation_not_implemented until later
// milestones add their handlers.
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
		fmt.Fprintf(os.Stderr, "kernel-conformance-adapter: failed to encode response: %v\n", err)
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
