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

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const FRAMEWORK_CONTRACTS_ROOT: &str = "boundaries/framework/contracts";
const RUST_IMPLEMENTATION_ID: &str = "rust-framework";

#[derive(Default)]
struct RustFrameworkAdapter {
    initialized: bool,
}

impl RustFrameworkAdapter {
    fn initialize(&mut self, _packet_id: &str, _plan_version: &str) {
        self.initialized = true;
    }

    fn dispatch(&self, operation: &str, input: &Value, controls: &Value) -> OperationOutcome {
        if !self.initialized {
            return OperationOutcome::Error {
                error: AdapterErrorEnvelope {
                    code: "rust_framework_adapter_not_initialized".to_string(),
                    details: Some(json!({
                        "operation": operation,
                        "receivedControlKeys": control_keys(controls),
                    })),
                    message: "Rust framework adapter was not initialized".to_string(),
                },
            };
        }

        OperationOutcome::Error {
            error: AdapterErrorEnvelope {
                code: "rust_framework_operation_not_implemented".to_string(),
                details: Some(json!({
                    "operation": operation,
                    "receivedInputKeys": input.as_object().map(|object| {
                        object.keys().cloned().collect::<Vec<_>>()
                    }).unwrap_or_default(),
                    "receivedControlKeys": control_keys(controls),
                })),
                message: "Rust framework, Runtime API, Event Stream, and ReAct Driver implementation path is not implemented yet".to_string(),
            },
        }
    }
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
    #[expect(
        dead_code,
        reason = "The neutral adapter protocol includes successful outcomes even though the current Rust framework adapter only reports unimplemented errors."
    )]
    #[serde(rename = "result")]
    Result { value: Value },
    #[serde(rename = "error")]
    Error { error: AdapterErrorEnvelope },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssertionResult {
    assertion_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    assertion_results: Vec<AssertionResult>,
    check_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceSummary {
    failed_checks: usize,
    passed_checks: usize,
    total_checks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    boundary: String,
    check_results: Vec<CheckResult>,
    implementation_id: &'static str,
    language: &'static str,
    status: &'static str,
    suite_id: &'static str,
    suite_version: &'static str,
    summary: EvidenceSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityPacket {
    conformance_plans: Vec<AuthorityPlanReference>,
    packet_id: String,
}

#[derive(Deserialize)]
struct AuthorityPlanReference {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConformancePlan {
    checks: Vec<PlanCheck>,
    packet_id: String,
    plan_id: String,
    plan_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCheck {
    assertions: Vec<PlanAssertion>,
    check_id: String,
    #[serde(default = "empty_controls")]
    controls: Value,
    #[serde(default)]
    input: Value,
    operation: String,
    #[serde(default)]
    scenario: Option<String>,
}

fn empty_controls() -> Value {
    json!({})
}

#[derive(Deserialize)]
struct PlanAssertion {
    kind: String,
}

struct LoadedPlan {
    path: String,
    plan: ConformancePlan,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let plans = load_promoted_framework_plans()?;
    let mut check_results = Vec::new();
    let mut adapter = RustFrameworkAdapter::default();

    for loaded_plan in &plans {
        adapter.initialize(&loaded_plan.plan.packet_id, &loaded_plan.plan.plan_version);

        for check in &loaded_plan.plan.checks {
            check_results.push(run_plan_check(&adapter, loaded_plan, check));
        }
    }

    let failed_checks = check_results
        .iter()
        .filter(|check_result| check_result.status == "fail")
        .count();
    let summary = EvidenceSummary {
        failed_checks,
        passed_checks: check_results.len() - failed_checks,
        total_checks: check_results.len(),
    };
    let evidence = Evidence {
        boundary: "framework".to_string(),
        check_results,
        implementation_id: RUST_IMPLEMENTATION_ID,
        language: "rust",
        status: if failed_checks == 0 { "pass" } else { "fail" },
        suite_id: "tuvren.framework.promoted-authority",
        suite_version: "0.1.0",
        summary,
    };

    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}

fn run_plan_check(
    adapter: &RustFrameworkAdapter,
    loaded_plan: &LoadedPlan,
    check: &PlanCheck,
) -> CheckResult {
    let input = json!({
        "checkId": check.check_id,
        "input": check.input.clone(),
        "scenario": check.scenario.clone(),
    });
    let outcome = adapter.dispatch(&check.operation, &input, &check.controls);
    let message = match &outcome {
        OperationOutcome::Error { error } => format!("{}: {}", error.code, error.message),
        OperationOutcome::Result { .. } => {
            "Rust framework runner does not yet evaluate successful operation results".to_string()
        }
    };
    let assertion_results = check
        .assertions
        .iter()
        .enumerate()
        .map(|(index, assertion)| AssertionResult {
            assertion_id: format!("{}.{}.{}", check.check_id, index + 1, assertion.kind),
            message: Some(message.clone()),
            status: "fail",
        })
        .collect::<Vec<_>>();

    CheckResult {
        assertion_results,
        check_id: check.check_id.clone(),
        details: Some(json!({
            "adapterOutcome": outcome,
            "authority": {
                "packetId": loaded_plan.plan.packet_id,
                "planId": loaded_plan.plan.plan_id,
                "planPath": loaded_plan.path,
                "planVersion": loaded_plan.plan.plan_version,
            },
            "controls": check.controls.clone(),
            "operation": check.operation.clone(),
        })),
        status: "fail",
    }
}

fn control_keys(controls: &Value) -> Vec<String> {
    controls
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
}

fn load_promoted_framework_plans() -> Result<Vec<LoadedPlan>, Box<dyn std::error::Error>> {
    let mut authority_packet_paths =
        find_authority_packet_paths(Path::new(FRAMEWORK_CONTRACTS_ROOT))?;
    authority_packet_paths.sort();
    let mut plan_paths = Vec::new();

    for packet_path in authority_packet_paths {
        let packet_text = fs::read_to_string(&packet_path)?;
        let packet: AuthorityPacket = serde_json::from_str(&packet_text)?;

        if !packet.packet_id.starts_with("tuvren.framework.") {
            continue;
        }

        for plan in packet.conformance_plans {
            plan_paths.push(plan.path);
        }
    }

    plan_paths.sort();
    plan_paths.dedup();

    let mut plans = Vec::new();

    for plan_path in plan_paths {
        let plan_text = fs::read_to_string(&plan_path)?;
        let plan: ConformancePlan = serde_json::from_str(&plan_text)?;
        plans.push(LoadedPlan {
            path: plan_path,
            plan,
        });
    }

    Ok(plans)
}

fn find_authority_packet_paths(root: &Path) -> Result<Vec<String>, std::io::Error> {
    let mut paths = Vec::new();
    collect_authority_packet_paths(root, &mut paths)?;
    Ok(paths)
}

fn collect_authority_packet_paths(
    current: &Path,
    paths: &mut Vec<String>,
) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            collect_authority_packet_paths(&path, paths)?;
            continue;
        }

        if path.file_name().and_then(|name| name.to_str()) == Some("authority-packet.json") {
            paths.push(path_to_repo_string(path));
        }
    }

    Ok(())
}

fn path_to_repo_string(path: PathBuf) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
