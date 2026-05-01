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

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, Default)]
pub struct AdapterControls {
    pub cancel: Option<AdapterCancelControl>,
    pub cancel_after_event: Option<String>,
    pub deadline_ms: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct AdapterCancelControl {
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub adapter_id: String,
    pub packet_id: String,
    pub plan_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum OperationOutcome {
    #[serde(rename = "result")]
    Result { value: Value },
    #[serde(rename = "error")]
    Error { error: AdapterErrorEnvelope },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<AdapterErrorEnvelope>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRecord {
    pub check_id: String,
    pub key: String,
    pub payload: Value,
}

pub trait ImplementationAdapter {
    fn dispatch(
        &mut self,
        operation: &str,
        input: Value,
        controls: AdapterControls,
    ) -> Result<OperationOutcome, String>;
    fn emit_evidence(&mut self, check_id: &str, key: &str, payload: Value);
    fn events(
        &mut self,
        operation: &str,
        input: Value,
        controls: AdapterControls,
    ) -> Result<Vec<Value>, String>;
    fn initialize(&mut self, packet_id: &str, plan_version: &str) -> AdapterCapabilities;
    fn inspect_state(&self, query: Value) -> Option<Value>;
    fn shutdown(&mut self);
}

#[derive(Default)]
pub struct ReferenceRustAdapter {
    pub evidence: Vec<EvidenceRecord>,
}

impl ImplementationAdapter for ReferenceRustAdapter {
    fn dispatch(
        &mut self,
        operation: &str,
        input: Value,
        controls: AdapterControls,
    ) -> Result<OperationOutcome, String> {
        reject_if_cancelled(&controls)?;
        Ok(OperationOutcome::Result {
            value: json!({ "input": input, "operation": operation }),
        })
    }

    fn emit_evidence(&mut self, check_id: &str, key: &str, payload: Value) {
        self.evidence.push(EvidenceRecord {
            check_id: check_id.to_string(),
            key: key.to_string(),
            payload,
        });
    }

    fn events(
        &mut self,
        operation: &str,
        input: Value,
        controls: AdapterControls,
    ) -> Result<Vec<Value>, String> {
        reject_if_cancelled(&controls)?;
        Ok(vec![json!({
            "input": input,
            "operation": operation,
            "sequence": 0
        })])
    }

    fn initialize(&mut self, packet_id: &str, plan_version: &str) -> AdapterCapabilities {
        AdapterCapabilities {
            adapter_id: "reference-rust-adapter".to_string(),
            packet_id: packet_id.to_string(),
            plan_version: plan_version.to_string(),
        }
    }

    fn inspect_state(&self, query: Value) -> Option<Value> {
        Some(json!({ "query": query }))
    }

    fn shutdown(&mut self) {
        self.evidence.clear();
    }
}

fn reject_if_cancelled(controls: &AdapterControls) -> Result<(), String> {
    // Cancellation is adapter mechanics. The plan still owns when cancellation
    // should be injected and what semantic outcome must be asserted.
    if let Some(cancel) = &controls.cancel {
        return Err(cancel.reason.clone());
    }

    Ok(())
}
