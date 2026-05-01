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

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

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
    #[serde(default)]
    fixtures: BTreeMap<String, String>,
    packet_id: String,
    plan_id: String,
    plan_version: String,
    #[serde(default)]
    scenarios: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCheck {
    assertions: Vec<PlanAssertion>,
    check_id: String,
    #[serde(default = "empty_controls")]
    controls: Value,
    #[serde(default)]
    fixture: Option<String>,
    #[serde(default)]
    input: Value,
    operation: String,
    #[serde(default)]
    scenario: Option<String>,
    #[serde(default)]
    evidence: Vec<String>,
}

fn empty_controls() -> Value {
    json!({})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanAssertion {
    #[serde(default)]
    contains: Option<Value>,
    #[serde(default)]
    equals: Option<Value>,
    #[serde(default)]
    event_type: Option<String>,
    #[serde(default)]
    field: Option<String>,
    kind: String,
    #[serde(default)]
    matches: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    schema: Option<String>,
}

struct LoadedPlan {
    fixtures: BTreeMap<String, Value>,
    path: String,
    plan: ConformancePlan,
    scenarios: BTreeMap<String, Value>,
}

struct CheckRunContext {
    adapter_outcome: Option<OperationOutcome>,
    assertion_context: AssertionContext,
}

#[derive(Default)]
struct AssertionContext {
    events: Option<Vec<Value>>,
    evidence: Option<Value>,
    result: Option<Value>,
    state: Option<Value>,
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

    if failed_checks > 0 {
        std::process::exit(1);
    }

    Ok(())
}

fn run_plan_check(
    adapter: &RustFrameworkAdapter,
    loaded_plan: &LoadedPlan,
    check: &PlanCheck,
) -> CheckResult {
    let context = create_check_run_context(adapter, loaded_plan, check);
    let assertion_results = match &context {
        Ok(run_context) => evaluate_assertions(check, &run_context.assertion_context),
        Err(message) => failed_assertions(check, message),
    };
    let status = if assertion_results
        .iter()
        .all(|assertion| assertion.status == "pass")
    {
        "pass"
    } else {
        "fail"
    };

    CheckResult {
        assertion_results,
        check_id: check.check_id.clone(),
        details: Some(create_details(loaded_plan, check, context.as_ref().ok())),
        status,
    }
}

fn evaluate_assertions(check: &PlanCheck, context: &AssertionContext) -> Vec<AssertionResult> {
    let mut results = check
        .assertions
        .iter()
        .enumerate()
        .map(|(index, assertion)| {
            let assertion_id = format!("{}.{}.{}", check.check_id, index + 1, assertion.kind);

            match evaluate_assertion(assertion, context) {
                Ok(true) => AssertionResult {
                    assertion_id,
                    message: None,
                    status: "pass",
                },
                Ok(false) => AssertionResult {
                    assertion_id,
                    message: None,
                    status: "fail",
                },
                Err(message) => AssertionResult {
                    assertion_id,
                    message: Some(message),
                    status: "fail",
                },
            }
        })
        .collect::<Vec<_>>();

    results.extend(evaluate_required_evidence(check, context));
    results
}

fn failed_assertions(check: &PlanCheck, message: &str) -> Vec<AssertionResult> {
    let mut results = check
        .assertions
        .iter()
        .enumerate()
        .map(|(index, assertion)| AssertionResult {
            assertion_id: format!("{}.{}.{}", check.check_id, index + 1, assertion.kind),
            message: Some(message.to_string()),
            status: "fail",
        })
        .collect::<Vec<_>>();

    for path in expanded_required_evidence(check) {
        results.push(AssertionResult {
            assertion_id: format!("{}.requiredEvidence.{}", check.check_id, path),
            message: Some(message.to_string()),
            status: "fail",
        });
    }

    results
}

fn evaluate_required_evidence(
    check: &PlanCheck,
    context: &AssertionContext,
) -> Vec<AssertionResult> {
    expanded_required_evidence(check)
        .into_iter()
        .map(|path| {
            let present = has_required_evidence(context, &path);

            AssertionResult {
                assertion_id: format!("{}.requiredEvidence.{}", check.check_id, path),
                message: if present {
                    None
                } else {
                    Some(format!("missing required evidence {path}"))
                },
                status: if present { "pass" } else { "fail" },
            }
        })
        .collect()
}

fn has_required_evidence(context: &AssertionContext, path: &str) -> bool {
    let json_path = format!("$.{path}");

    if context
        .evidence
        .as_ref()
        .is_some_and(|evidence| read_path(evidence, &json_path).is_some())
    {
        return true;
    }

    if context
        .state
        .as_ref()
        .is_some_and(|state| read_path(state, &json_path).is_some())
    {
        return true;
    }

    if let Some(events) = &context.events
        && read_path(&json!({ "events": events }), &json_path).is_some()
    {
        return true;
    }

    context
        .result
        .as_ref()
        .is_some_and(|result| read_path(&json!({ "result": result }), &json_path).is_some())
}

fn expanded_required_evidence(check: &PlanCheck) -> BTreeSet<String> {
    let mut evidence = check.evidence.iter().cloned().collect::<BTreeSet<_>>();

    for assertion in &check.assertions {
        let path = assertion.field.as_ref().or(assertion.path.as_ref());

        if let Some(path) = path
            && matches!(
                assertion.kind.as_str(),
                "evidenceField" | "stateField" | "errorEnvelope"
            )
        {
            evidence.insert(normalize_evidence_path(path));
        }
    }

    evidence
}

fn normalize_evidence_path(path: &str) -> String {
    path.strip_prefix("$.").unwrap_or(path).to_string()
}

fn create_check_run_context(
    adapter: &RustFrameworkAdapter,
    loaded_plan: &LoadedPlan,
    check: &PlanCheck,
) -> Result<CheckRunContext, String> {
    let input = create_adapter_input(loaded_plan, check)?;
    let outcome = adapter.dispatch(&check.operation, &input, &check.controls);
    let assertion_context = create_adapter_assertion_context(&outcome);

    Ok(CheckRunContext {
        adapter_outcome: Some(outcome),
        assertion_context,
    })
}

fn create_adapter_input(loaded_plan: &LoadedPlan, check: &PlanCheck) -> Result<Value, String> {
    let mut input = Map::new();
    input.insert("checkInput".to_string(), check.input.clone());

    if let Some(scenario_id) = &check.scenario {
        let scenario = loaded_plan
            .scenarios
            .get(scenario_id)
            .ok_or_else(|| format!("unknown scenario {scenario_id}"))?;
        let scenario_value = match read_input_string_optional(&check.input, "scenarioPath")? {
            Some(path) => read_path(scenario, &path)
                .cloned()
                .ok_or_else(|| format!("scenario path {path} did not resolve"))?,
            None => scenario.clone(),
        };

        input.insert("scenario".to_string(), scenario_value);
    }

    if let Some(fixture_id) = &check.fixture {
        let fixture = loaded_plan
            .fixtures
            .get(fixture_id)
            .ok_or_else(|| format!("unknown fixture {fixture_id}"))?;
        let fixture_value = match read_input_string_optional(&check.input, "fixturePath")? {
            Some(path) => read_path(fixture, &path)
                .cloned()
                .ok_or_else(|| format!("fixture path {path} did not resolve"))?,
            None => fixture.clone(),
        };

        input.insert("fixture".to_string(), fixture_value);
    }

    Ok(Value::Object(input))
}

fn create_adapter_assertion_context(outcome: &OperationOutcome) -> AssertionContext {
    match outcome {
        OperationOutcome::Error { error } => AssertionContext {
            // Adapter protocol errors are runner/adapter failures, not
            // implementation-produced results that can satisfy a plan assertion.
            state: Some(json!({ "adapterError": error })),
            ..AssertionContext::default()
        },
        OperationOutcome::Result { value } => {
            let evidence = read_object_field(value, "evidence");
            let events = read_array_field(value, "events");
            let result = read_value_field(value, "result");
            let state = read_object_field(value, "state");

            AssertionContext {
                events,
                evidence,
                result,
                state,
            }
        }
    }
}

fn read_object_field(value: &Value, field: &str) -> Option<Value> {
    value
        .get(field)
        .filter(|entry| entry.as_object().is_some())
        .cloned()
}

fn read_array_field(value: &Value, field: &str) -> Option<Vec<Value>> {
    value.get(field).and_then(Value::as_array).cloned()
}

fn read_value_field(value: &Value, field: &str) -> Option<Value> {
    value.get(field).cloned()
}

fn evaluate_assertion(
    assertion: &PlanAssertion,
    context: &AssertionContext,
) -> Result<bool, String> {
    match assertion.kind.as_str() {
        "eventSequence" => assert_event_sequence(assertion, context),
        "terminalEvent" => assert_terminal_event(assertion, context),
        "schemaValid" => assert_schema_valid(assertion, context),
        "errorEnvelope" => assert_error_envelope(assertion, context),
        "stateField" => assert_field(assertion, context.state.as_ref()),
        "evidenceField" => assert_field(assertion, context.evidence.as_ref()),
        "ordering" => assert_ordering(assertion, context),
        "noEvent" => assert_no_event(assertion, context),
        kind => Err(format!("unsupported assertion kind {kind}")),
    }
}

fn assert_event_sequence(
    assertion: &PlanAssertion,
    context: &AssertionContext,
) -> Result<bool, String> {
    let events = read_events(context)?;
    let path = assertion.path.as_deref().unwrap_or("$.type");
    let actual = events
        .iter()
        .map(|event| read_path(event, path).cloned().unwrap_or(Value::Null))
        .collect::<Vec<_>>();

    Ok(assertion.equals.as_ref() == Some(&Value::Array(actual)))
}

fn assert_terminal_event(
    assertion: &PlanAssertion,
    context: &AssertionContext,
) -> Result<bool, String> {
    let events = read_events(context)?;
    let terminal_event = match events.last() {
        Some(event) => event,
        None => return Ok(false),
    };
    let path = assertion.path.as_deref().unwrap_or("$");
    let value = read_path(terminal_event, path);

    if let Some(event_type) = &assertion.event_type {
        return Ok(value == Some(&Value::String(event_type.clone())));
    }

    assert_value(assertion, value)
}

fn assert_schema_valid(
    assertion: &PlanAssertion,
    context: &AssertionContext,
) -> Result<bool, String> {
    let schema_path = assertion
        .schema
        .as_ref()
        .ok_or_else(|| "schemaValid assertion requires schema".to_string())?;
    let context_value = context_to_value(context);
    let value_path = assertion.path.as_deref().unwrap_or("$.result");
    let value = match read_path(&context_value, value_path) {
        Some(value) => value,
        None => return Ok(false),
    };
    let schema = read_path(&context_value, schema_path)
        .ok_or_else(|| format!("{schema_path} must contain a JSON Schema value"))?;
    let validator = jsonschema::validator_for(schema)
        .map_err(|error| format!("{schema_path} contains invalid JSON Schema: {error}"))?;

    Ok(validator.is_valid(value))
}

fn assert_error_envelope(
    assertion: &PlanAssertion,
    context: &AssertionContext,
) -> Result<bool, String> {
    let context_value = context_to_value(context);
    let path = assertion.path.as_deref().unwrap_or("$.result.error");
    let value = match read_path(&context_value, path) {
        Some(value) => value,
        None => return Ok(false),
    };
    let has_code = value
        .as_object()
        .and_then(|object| object.get("code"))
        .and_then(Value::as_str)
        .is_some();

    if !has_code {
        return Ok(false);
    }

    assert_value(assertion, Some(value))
}

fn assert_field(assertion: &PlanAssertion, source: Option<&Value>) -> Result<bool, String> {
    let field = assertion
        .field
        .as_ref()
        .ok_or_else(|| format!("{} assertion requires field", assertion.kind))?;
    let value = match source {
        Some(source_value) => read_path(source_value, field),
        None => None,
    };

    assert_value(assertion, value)
}

fn assert_ordering(assertion: &PlanAssertion, context: &AssertionContext) -> Result<bool, String> {
    let events = read_events(context)?;
    let contains = assertion
        .contains
        .as_ref()
        .and_then(Value::as_array)
        .ok_or_else(|| "ordering assertion requires contains with two event types".to_string())?;

    if contains.len() != 2 {
        return Err("ordering assertion requires contains with two event types".to_string());
    }

    let first = contains[0]
        .as_str()
        .ok_or_else(|| "ordering assertion event types must be strings".to_string())?;
    let second = contains[1]
        .as_str()
        .ok_or_else(|| "ordering assertion event types must be strings".to_string())?;
    let path = assertion.path.as_deref().unwrap_or("$.type");
    let event_types = events
        .iter()
        .map(|event| read_path(event, path).cloned().unwrap_or(Value::Null))
        .collect::<Vec<_>>();
    let first_value = Value::String(first.to_string());
    let second_value = Value::String(second.to_string());
    let first_index = event_types.iter().position(|event| event == &first_value);
    let second_index = event_types.iter().position(|event| event == &second_value);

    Ok(matches!(
        (first_index, second_index),
        (Some(first_position), Some(second_position)) if first_position < second_position
    ))
}

fn assert_no_event(assertion: &PlanAssertion, context: &AssertionContext) -> Result<bool, String> {
    let event_type = assertion
        .event_type
        .as_ref()
        .ok_or_else(|| "noEvent assertion requires eventType".to_string())?;
    let events = read_events(context)?;
    let path = assertion.path.as_deref().unwrap_or("$.type");
    let expected = Value::String(event_type.clone());

    Ok(events
        .iter()
        .all(|event| read_path(event, path) != Some(&expected)))
}

fn assert_value(assertion: &PlanAssertion, value: Option<&Value>) -> Result<bool, String> {
    if let Some(expected) = &assertion.equals {
        return Ok(value == Some(expected));
    }

    if let Some(expected) = &assertion.contains {
        return Ok(value.is_some_and(|actual| value_contains(actual, expected)));
    }

    if let Some(pattern) = &assertion.matches {
        let Some(Value::String(actual)) = value else {
            return Ok(false);
        };
        let regex = Regex::new(pattern)
            .map_err(|error| format!("matches pattern {pattern} is invalid: {error}"))?;

        return Ok(regex.is_match(actual));
    }

    Ok(value.is_some())
}

fn value_contains(value: &Value, expected: &Value) -> bool {
    if let Some(entries) = value.as_array() {
        return entries.iter().any(|entry| entry == expected);
    }

    if let (Some(actual), Some(expected)) = (value.as_str(), expected.as_str()) {
        return actual.contains(expected);
    }

    if let (Some(object), Some(expected_key)) = (value.as_object(), expected.as_str()) {
        return object.contains_key(expected_key);
    }

    false
}

fn read_events(context: &AssertionContext) -> Result<&Vec<Value>, String> {
    context
        .events
        .as_ref()
        .ok_or_else(|| "assertion requires events".to_string())
}

fn context_to_value(context: &AssertionContext) -> Value {
    let mut object = Map::new();

    if let Some(events) = &context.events {
        object.insert("events".to_string(), Value::Array(events.clone()));
    }

    if let Some(evidence) = &context.evidence {
        object.insert("evidence".to_string(), evidence.clone());
    }

    if let Some(result) = &context.result {
        object.insert("result".to_string(), result.clone());
    }

    if let Some(state) = &context.state {
        object.insert("state".to_string(), state.clone());
    }

    Value::Object(object)
}

fn read_path<'a>(source: &'a Value, path: &str) -> Option<&'a Value> {
    if path == "$" {
        return Some(source);
    }

    let path = path.strip_prefix("$.")?;
    let mut current = source;

    for segment in path.split('.') {
        if let Some(array) = current.as_array() {
            let index = segment.parse::<usize>().ok()?;
            current = array.get(index)?;
            continue;
        }

        current = current.as_object()?.get(segment)?;
    }

    Some(current)
}

fn read_input_string_optional(input: &Value, key: &str) -> Result<Option<String>, String> {
    let Some(object) = input.as_object() else {
        return Ok(None);
    };
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let Some(text) = value.as_str() else {
        return Err(format!("check input {key} must be a string when present"));
    };

    Ok(Some(text.to_string()))
}

fn create_details(
    loaded_plan: &LoadedPlan,
    check: &PlanCheck,
    context: Option<&CheckRunContext>,
) -> Value {
    let mut details = Map::new();
    details.insert(
        "authority".to_string(),
        json!({
            "packetId": loaded_plan.plan.packet_id,
            "planId": loaded_plan.plan.plan_id,
            "planPath": loaded_plan.path,
            "planVersion": loaded_plan.plan.plan_version,
        }),
    );
    details.insert("controls".to_string(), check.controls.clone());
    details.insert(
        "operation".to_string(),
        Value::String(check.operation.clone()),
    );

    if let Some(run_context) = context {
        if let Some(outcome) = &run_context.adapter_outcome {
            details.insert("adapterOutcome".to_string(), json!(outcome));
        }

        add_context_details(&mut details, &run_context.assertion_context);
    } else {
        details.insert(
            "runnerError".to_string(),
            Value::String("runner could not build assertion context".to_string()),
        );
    }

    Value::Object(details)
}

fn add_context_details(details: &mut Map<String, Value>, context: &AssertionContext) {
    if let Some(events) = &context.events {
        details.insert(
            "eventTypes".to_string(),
            Value::Array(
                events
                    .iter()
                    .map(|event| read_path(event, "$.type").cloned().unwrap_or(Value::Null))
                    .collect(),
            ),
        );
    }

    if let Some(Value::Object(evidence)) = &context.evidence {
        for (key, value) in evidence {
            details.insert(key.clone(), value.clone());
        }
    }

    if let Some(result) = &context.result {
        details.insert("result".to_string(), result.clone());
    }

    if let Some(state) = &context.state {
        details.insert("state".to_string(), state.clone());
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
        let fixtures = load_plan_resources(&plan_path, &plan.fixtures)?;
        let scenarios = load_plan_resources(&plan_path, &plan.scenarios)?;

        plans.push(LoadedPlan {
            fixtures,
            path: plan_path,
            plan,
            scenarios,
        });
    }

    Ok(plans)
}

fn load_plan_resources(
    plan_path: &str,
    resources: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, Value>, Box<dyn std::error::Error>> {
    let plan_directory = Path::new(plan_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut loaded = BTreeMap::new();

    for (resource_id, resource_path) in resources {
        let absolute_path = plan_directory.join(resource_path);
        let resource_text = fs::read_to_string(absolute_path)?;
        let resource: Value = serde_json::from_str(&resource_text)?;

        loaded.insert(resource_id.clone(), resource);
    }

    Ok(loaded)
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
