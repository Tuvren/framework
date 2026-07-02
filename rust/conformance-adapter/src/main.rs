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

use std::io::{self, BufRead};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Value,
    jsonrpc: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterCapabilities {
    adapter_id: &'static str,
    capabilities: Vec<&'static str>,
    packet_id: String,
    plan_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterErrorEnvelope {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Serialize)]
#[serde(tag = "kind")]
enum OperationOutcome {
    #[serde(rename = "error")]
    Error { error: AdapterErrorEnvelope },
}

fn main() {
    for line in io::stdin().lock().lines() {
        let response = match line {
            Ok(text) => handle_line(&text),
            Err(source) => error_response(
                Value::Null,
                "adapter_stdin_failed",
                &format!("failed to read adapter stdin: {source}"),
            ),
        };
        println!("{response}");
    }
}

fn handle_line(line: &str) -> Value {
    let request = match serde_json::from_str::<JsonRpcRequest>(line) {
        Ok(request) => request,
        Err(source) => {
            return error_response(
                Value::Null,
                "invalid_json_rpc_request",
                &format!("failed to parse JSON-RPC request: {source}"),
            );
        }
    };
    if request.jsonrpc != "2.0" {
        return error_response(
            request.id,
            "invalid_json_rpc_request",
            "request jsonrpc must be 2.0",
        );
    }
    let id = request.id.clone();

    match dispatch_request(request) {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    }
}

fn dispatch_request(request: JsonRpcRequest) -> Result<Value, AdapterErrorEnvelope> {
    match request.method.as_str() {
        "initialize" => Ok(json!(AdapterCapabilities {
            adapter_id: "rust-framework",
            capabilities: Vec::<&'static str>::new(),
            packet_id: read_param_string(&request.params, "packetId")?,
            plan_version: read_param_string(&request.params, "planVersion")?,
        })),
        "dispatch" => {
            let operation = read_param_string(&request.params, "operation")?;
            Ok(json!(OperationOutcome::Error {
                error: AdapterErrorEnvelope {
                    code: "rust_framework_operation_not_implemented".to_string(),
                    message: "Rust framework, Runtime API, Event Stream, and ReAct Driver implementation path is not implemented yet".to_string(),
                    details: Some(json!({ "operation": operation })),
                },
            }))
        }
        "events" => Ok(json!([])),
        "inspectState" | "createInstance" | "destroyInstance" | "shutdown" => Ok(Value::Null),
        method => Err(adapter_error(
            "adapter_method_not_implemented",
            &format!("unsupported adapter method {method}"),
            None,
        )),
    }
}

fn read_param_string(params: &Value, key: &str) -> Result<String, AdapterErrorEnvelope> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            adapter_error(
                "invalid_adapter_request",
                &format!("{key} must be a string"),
                None,
            )
        })
}

fn adapter_error(code: &str, message: &str, details: Option<Value>) -> AdapterErrorEnvelope {
    AdapterErrorEnvelope {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn error_response(id: Value, code: &str, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": adapter_error(code, message, None)
    })
}
