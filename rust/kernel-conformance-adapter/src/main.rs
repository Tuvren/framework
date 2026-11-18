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

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod host_stdio;
mod host_syscalls;
mod observation_encoding;
mod syscall_values;

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
    protocol_version: &'static str,
    profiles: Vec<&'static str>,
    storage_kinds: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterErrorEnvelope {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
enum OperationOutcome {
    #[serde(rename = "result")]
    Result { value: Value },
    #[serde(rename = "error")]
    Error { error: AdapterErrorEnvelope },
}

fn main() {
    let syscalls = Arc::new(
        host_syscalls::Syscalls::configured().unwrap_or_else(|message| {
            eprintln!("{message}");
            std::process::exit(2);
        }),
    );
    host_stdio::serve(syscalls);
}

#[derive(Deserialize)]
struct CorrelatedId {
    id: Value,
}

fn correlated_id(line: &str) -> Value {
    serde_json::from_str::<CorrelatedId>(line)
        .ok()
        .map(|request| request.id)
        .filter(|id| id.is_string() || id.is_number())
        .unwrap_or(Value::Null)
}

type PreparedOperation = Option<Result<Arc<host_syscalls::Operation>, AdapterErrorEnvelope>>;

fn handle_line(
    line: &str,
    syscalls: &Arc<host_syscalls::Syscalls>,
    prepared: PreparedOperation,
) -> Value {
    let request = match observation_encoding::parse_frame(line)
        .and_then(serde_json::from_value::<JsonRpcRequest>)
    {
        Ok(request) => request,
        Err(source) => {
            return error_response(
                correlated_id(line),
                "invalid_json_rpc_request",
                &format!("failed to parse JSON-RPC request: {source}"),
            );
        }
    };
    if request.jsonrpc != "2.0" || !(request.id.is_string() || request.id.is_number()) {
        return error_response(
            correlated_id(line),
            "invalid_json_rpc_request",
            "request jsonrpc must be 2.0",
        );
    }
    let id = request.id.clone();

    match dispatch_request(request, syscalls, prepared) {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    }
}

fn dispatch_request(
    request: JsonRpcRequest,
    syscalls: &Arc<host_syscalls::Syscalls>,
    prepared: PreparedOperation,
) -> Result<Value, AdapterErrorEnvelope> {
    match request.method.as_str() {
        "initialize" => Ok(json!(AdapterCapabilities {
            adapter_id: "rust-kernel",
            capabilities: vec![
                "kernel.syscall",
                "kernel.codec",
                "kernel.scope-isolation",
                "kernel.barrier",
                "kernel.fault-injection",
                "kernel.protocol",
                "kernel.edge-validation",
                "kernel.logical",
                "kernel-protocol.thread.enumeration",
                "kernel.run-liveness",
                "kernel.reclamation",
            ],
            packet_id: read_param_string(&request.params, "packetId")?,
            plan_version: read_param_string(&request.params, "planVersion")?,
            protocol_version: "0.2.0",
            profiles: if std::env::args().any(|arg| arg == "--mutant-from-env") {
                vec![]
            } else {
                vec!["kernel.memory"]
            },
            storage_kinds: vec!["none"],
        })),
        "dispatch" => {
            let operation = read_param_string(&request.params, "operation")?;
            let input = request.params.get("input").cloned().unwrap_or(Value::Null);
            if host_syscalls::Syscalls::has(&operation) {
                let handle = request
                    .params
                    .get("instance")
                    .or_else(|| input.get("instance"))
                    .unwrap_or(&Value::Null);
                return Ok(json!(syscalls.dispatch(&operation, &input, handle)?));
            }
            Err(adapter_error(
                "adapter_operation_not_implemented",
                &format!("rust kernel adapter does not implement {operation}"),
                None,
            ))
        }
        "events" => Ok(json!([])),
        "createInstance" => Ok(json!(syscalls.create(&request.params)?)),
        "startOperation" => {
            let operation = read_param_string(&request.params, "operation")?;
            let input = request.params.get("arguments").cloned().ok_or_else(|| {
                adapter_error("invalid_adapter_request", "arguments required", None)
            })?;
            let instance = request
                .params
                .get("instance")
                .cloned()
                .unwrap_or(Value::Null);
            syscalls.start(operation, input, instance)
        }
        "awaitOperation" => Ok(json!(syscalls.await_operation(
            &read_param_string(&request.params, "operationHandle")?,
            prepared
        )?)),
        "cancelOperation" => {
            syscalls.cancel(
                &read_param_string(&request.params, "operationHandle")?,
                &read_param_string(&request.params, "reason")?,
            )?;
            Ok(Value::Null)
        }
        "destroyInstance" => {
            syscalls.destroy(request.params.get("instance").unwrap_or(&Value::Null))?;
            Ok(Value::Null)
        }
        "shutdown" => {
            syscalls.shutdown()?;
            Ok(Value::Null)
        }
        "inspectState" => Ok(Value::Null),
        method => syscalls
            .protocol_control(method, &request.params)
            .unwrap_or_else(|| {
                Err(adapter_error(
                    "adapter_method_not_implemented",
                    &format!("unsupported adapter method {method}"),
                    None,
                ))
            }),
    }
}

fn read_param_string(params: &Value, key: &str) -> Result<String, AdapterErrorEnvelope> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
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

