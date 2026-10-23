use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct Adapter {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Adapter {
    fn new() -> Self {
        Self::with_args(&[])
    }
    fn with_args(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tuvren-kernel-rust-conformance-adapter"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn raw(&mut self, frame: &str) -> Value {
        writeln!(self.input, "{frame}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.raw(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string())
    }
    fn instance(&mut self) -> Value {
        let response = self.request("createInstance", json!({"input":{}}));
        assert!(response["result"].is_string(), "{response}");
        let instance = response["result"].clone();
        for domain in ["backend", "worker"] {
            self.result(
                &instance,
                "kernel.clock.set",
                json!({"domain":domain,"nowMs":0}),
            );
        }
        instance
    }
    fn call(&mut self, instance: &Value, operation: &str, input: Value) -> Value {
        self.request(
            "dispatch",
            json!({"instance":instance,"operation":operation,"input":input}),
        )
    }
    fn result(&mut self, instance: &Value, operation: &str, input: Value) -> Value {
        let response = self.call(instance, operation, input);
        assert_eq!(response["result"]["kind"], "result", "{response}");
        response["result"]["value"]["result"].clone()
    }
}
impl Drop for Adapter {
    fn drop(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}

#[test]
fn bytes_and_instance_lifetimes_are_native() {
    let mut adapter = Adapter::new();
    let a = adapter.instance();
    let b = adapter.instance();
    let hash = adapter.result(&a, "kernel.store.put", json!({"blob":{"$bytes":"00ff80"}}));
    assert_eq!(
        adapter.result(&a, "kernel.store.get", json!({"hash":hash})),
        json!({"$bytes":"00ff80"})
    );
    assert_eq!(
        adapter.result(&b, "kernel.store.get", json!({"hash":hash})),
        Value::Null
    );
    adapter.request("destroyInstance", json!({"instance":a}));
    assert!(adapter.call(&a, "kernel.store.has", json!({"hash":hash}))["error"].is_object());
    assert_eq!(
        adapter.request(
            "initialize",
            json!({"packetId":"test","planVersion":"0.1.0"})
        )["result"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| *v == "kernel.syscall")
            .count(),
        1
    );
}

#[test]
fn rejects_duplicate_keys_and_non_lossless_arguments_as_protocol_errors() {
    let mut adapter = Adapter::new();
    for frame in [
        r#"{"jsonrpc":"2.0","id":1,"method":"events","params":{"x":1,"\u0078":2}}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"events","params":{"nested":[{"x":1,"x":2}]}}"#,
    ] {
        assert!(adapter.raw(frame)["error"].is_object());
    }
    let instance = adapter.instance();
    for blob in [
        json!({"$bytes":"FF"}),
        json!({"$bytes":"0"}),
        json!({"$bytes":"00","extra":1}),
    ] {
        assert!(
            adapter.call(&instance, "kernel.store.put", json!({"blob":blob}))["error"].is_object()
        );
    }
    for record in [
        json!({"$map":[["a",1],["a",2]]}),
        json!({"$map":[[1,true]]}),
        json!(9007199254740992_i64),
        json!(1.5),
        json!(-0.0),
    ] {
        assert!(
            adapter.call(
                &instance,
                "kernel.verdicts.compose",
                json!({"verdicts":[{"kind":"modify","transform":record}]})
            )["error"]
                .is_object()
        );
    }
}

#[test]
fn tagged_records_preserve_transport_tag_keys_and_safe_integers() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    let transform = json!({"$map":[["$bytes", "user data"],["nested",{"$bytes":"00ff"}],["integer",9007199254740991_i64],["min",-9007199254740991_i64]]});
    let observed = adapter.result(
        &instance,
        "kernel.verdicts.compose",
        json!({"verdicts":[{"kind":"modify","transform":transform}]}),
    );
    let entries = observed["transform"]["$map"].as_array().unwrap();
    for entry in transform["$map"].as_array().unwrap() {
        assert!(entries.contains(entry));
    }
}

#[test]
fn recovery_reads_live_kernel_state_and_native_errors_are_unchanged() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    let schema = json!({"schemaId":"s","paths":[{"path":"messages","collection":"ordered"}],"incorporationRules":[{"objectType":"message","targetPath":"messages"}]});
    adapter.result(
        &instance,
        "kernel.schema.register",
        json!({"schema":schema}),
    );
    let duplicate = adapter.call(
        &instance,
        "kernel.schema.register",
        json!({"schema":schema}),
    );
    assert_eq!(
        duplicate["result"]["error"],
        json!({"code":"schema_already_exists","message":"schema already exists"})
    );
    let thread = adapter.result(
        &instance,
        "kernel.thread.create",
        json!({"threadId":"t","schemaId":"s","initialBranchId":"b"}),
    );
    adapter.result(&instance,"kernel.turn.create",json!({"turnId":"t","threadId":"t","branchId":"b","startTurnNodeHash":thread["rootTurnNodeHash"]}));
    adapter.result(&instance,"kernel.run.create",json!({"runId":"r","turnId":"t","branchId":"b","schemaId":"s","startTurnNodeHash":thread["rootTurnNodeHash"],"steps":[{"id":"one","deterministic":false,"sideEffects":false},{"id":"two","deterministic":false,"sideEffects":false}]}));
    let staged = adapter.result(&instance,"kernel.staging.stage",json!({"runId":"r","blob":{"$bytes":"01"},"taskId":"consumed","objectType":"message","status":"completed"}));
    let annotation = tuvren_kernel_rust::KernelRecord::Map(std::collections::BTreeMap::from([(
        "note".into(),
        tuvren_kernel_rust::KernelRecord::Bytes(vec![0, 255]),
    )]));
    let annotation_bytes =
        tuvren_kernel_rust::encode_deterministic_kernel_record(&annotation).unwrap();
    let annotation_hash = tuvren_kernel_rust::hash_bytes_to_hex(&annotation_bytes);
    let checkpoint = adapter.result(
        &instance,
        "kernel.run.completeStep",
        json!({"runId":"r","stepId":"one","observeResults":[{"annotations":[{"$map":[["note",{"$bytes":"00ff"}]]}],"signals":[{"$bytes":"01"}]}]}),
    );
    let annotation_hex = annotation_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        adapter.result(
            &instance,
            "kernel.store.get",
            json!({"hash":annotation_hash})
        ),
        json!({"$bytes":annotation_hex})
    );
    let next_step = adapter.result(
        &instance,
        "kernel.run.beginStep",
        json!({"runId":"r","stepId":"two"}),
    );
    assert_eq!(next_step["signals"], json!([{"$bytes":"01"}]));
    let pending = adapter.result(&instance,"kernel.staging.stage",json!({"runId":"r","blob":{"$bytes":"02"},"taskId":"pending","objectType":"message","status":"interrupted","interruptPayload":{"$map":[["reason","wait"]]}}));
    let recovery = adapter.result(
        &instance,
        "kernel.run.recover",
        json!({"runId":"r","fixture":{"recoveryState":{"lastCompletedStepId":"forged"}}}),
    );
    assert_eq!(recovery["lastCompletedStepId"], "one");
    assert_eq!(recovery["lastTurnNodeHash"], checkpoint["turnNodeHash"]);
    assert_eq!(
        recovery["consumedStagedResults"],
        json!([staged["stagedResult"]])
    );
    assert_eq!(
        recovery["uncommittedStagedResults"],
        json!([pending["stagedResult"]])
    );
}

#[test]
fn unsupported_syscalls_are_protocol_failures() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    let response = adapter.call(&instance, "kernel.unsupported", json!({}));
    assert_eq!(
        response["error"]["code"],
        "adapter_operation_not_implemented"
    );
    assert!(response.get("result").is_none());
}

#[test]
fn integer_tokens_are_checked_before_float_rounding() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    for token in [
        "1.5",
        "9007199254740991.1",
        "9007199254740990.5",
        "-0",
        "-0.0",
        "1e9999",
        "1e-9999",
    ] {
        let frame = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"dispatch","params":{{"instance":{instance},"operation":"kernel.verdicts.compose","input":{{"verdicts":[{{"kind":"modify","transform":{token}}}]}}}}}}"#
        );
        assert!(adapter.raw(&frame)["error"].is_object(), "{token}");
    }
    for token in ["1.0", "10e-1", "0.1e1", "9007199254740991.0"] {
        let frame = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"dispatch","params":{{"instance":{instance},"operation":"kernel.verdicts.compose","input":{{"verdicts":[{{"kind":"modify","transform":{token}}}]}}}}}}"#
        );
        assert_eq!(adapter.raw(&frame)["result"]["kind"], "result", "{token}");
    }
}

#[test]
fn controls_require_explicit_clocks_before_kernel_initialization() {
    let mut adapter = Adapter::new();
    let instance = adapter.request("createInstance", json!({"input":{}}))["result"].clone();
    assert!(
        adapter.call(
            &instance,
            "kernel.store.put",
            json!({"blob":{"$bytes":"01"}})
        )["error"]
            .is_object()
    );
    adapter.result(
        &instance,
        "kernel.clock.set",
        json!({"domain":"worker","nowMs":700}),
    );
    assert!(
        adapter.call(
            &instance,
            "kernel.store.put",
            json!({"blob":{"$bytes":"01"}})
        )["error"]
            .is_object()
    );
    adapter.result(
        &instance,
        "kernel.clock.set",
        json!({"domain":"backend","nowMs":100}),
    );
    adapter.result(
        &instance,
        "kernel.store.put",
        json!({"blob":{"$bytes":"01"}}),
    );
}

#[test]
fn invalid_clock_inputs_are_protocol_errors() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    for input in [
        json!({"domain":"worker","nowMs":-1}),
        json!({"domain":"backend","nowMs":-1}),
        json!({"domain":"worker","nowMs":9007199254740992_i64}),
        json!({"domain":"backend","nowMs":1.5}),
        json!({"domain":"unknown","nowMs":0}),
    ] {
        let response = adapter.call(&instance, "kernel.clock.set", input);
        assert!(response["error"].is_object(), "{response}");
        assert!(response.get("result").is_none(), "{response}");
    }
}

#[test]
fn invalid_fault_inputs_are_protocol_errors() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    for occurrence in [json!(0), json!(-1), json!(1.5), json!(9007199254740992_u64)] {
        for point in ["before-commit", "commit-outcome-unknown"] {
            let response = adapter.call(
                &instance,
                "kernel.fault.arm",
                json!({
                    "point": point, "mode": "throw", "selector": {}, "occurrence": occurrence
                }),
            );
            assert!(response["error"].is_object(), "{response}");
            assert!(response.get("result").is_none(), "{response}");
        }
    }
}

#[test]
fn unsupported_fault_phases_and_block_mode_use_catalogued_error() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    for (point, mode) in [
        ("after-turn-node-write-before-head", "throw"),
        ("after-head-move-before-staging-clear", "throw"),
        ("commit-outcome-unknown", "throw"),
        ("before-commit", "block"),
        ("after-commit-before-ack", "block"),
    ] {
        let response = adapter.call(
            &instance,
            "kernel.fault.arm",
            json!({"point":point,"selector":{},"occurrence":1,"mode":mode}),
        );
        assert_eq!(
            response["result"]["error"]["code"], "kernel_fault_point_unsupported",
            "{response}"
        );
    }
}

#[test]
fn supported_faults_carry_activation_tokens_and_preserve_atomic_checkpoints() {
    let mut adapter = Adapter::new();
    for point in ["before-commit", "after-commit-before-ack"] {
        let instance = adapter.instance();
        for domain in ["backend", "worker"] {
            adapter.result(
                &instance,
                "kernel.clock.set",
                json!({"domain":domain,"nowMs":0}),
            );
        }
        adapter.result(&instance, "kernel.schema.register", json!({"schema":{"schemaId":"s","paths":[{"path":"p","collection":"ordered"}],"incorporationRules":[{"objectType":"o","targetPath":"p"}]}}));
        let thread = adapter.result(
            &instance,
            "kernel.thread.create",
            json!({"threadId":"t","schemaId":"s","initialBranchId":"b"}),
        );
        adapter.result(&instance,"kernel.turn.create",json!({"turnId":"t","threadId":"t","branchId":"b","startTurnNodeHash":thread["rootTurnNodeHash"]}));
        adapter.result(&instance,"kernel.run.create",json!({"runId":"r","turnId":"t","branchId":"b","schemaId":"s","startTurnNodeHash":thread["rootTurnNodeHash"],"steps":[{"id":"one","deterministic":false,"sideEffects":false},{"id":"two","deterministic":false,"sideEffects":false}]}));
        adapter.result(&instance,"kernel.staging.stage",json!({"runId":"r","blob":{"$bytes":"01"},"taskId":"task","objectType":"o","status":"completed"}));
        let arming = adapter.result(&instance, "kernel.fault.arm", json!({"point":point,"selector":{"operation":"checkpoint","branchId":"b"},"occurrence":1,"mode":"throw"}));
        assert_eq!(arming["token"], "fault-1");
        let response = adapter.call(
            &instance,
            "kernel.run.completeStep",
            json!({"runId":"r","stepId":"one"}),
        );
        assert_eq!(
            response["result"]["error"]["code"], "kernel_persistence_fault_injected",
            "{response}"
        );
        assert_eq!(
            response["result"]["error"]["details"],
            json!({"token":arming["token"],"point":point})
        );
        let recovered = adapter.result(&instance, "kernel.run.recover", json!({"runId":"r"}));
        let branch = adapter.result(&instance, "kernel.branch.get", json!({"branchId":"b"}));
        assert_eq!(recovered["lastTurnNodeHash"], branch["headTurnNodeHash"]);
        if point == "before-commit" {
            assert_eq!(recovered["lastTurnNodeHash"], thread["rootTurnNodeHash"]);
            assert_eq!(
                recovered["uncommittedStagedResults"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(recovered["lastCompletedStepId"], Value::Null);
            adapter.result(
                &instance,
                "kernel.run.completeStep",
                json!({"runId":"r","stepId":"one"}),
            );
        } else {
            assert_ne!(recovered["lastTurnNodeHash"], thread["rootTurnNodeHash"]);
            assert_eq!(recovered["uncommittedStagedResults"], json!([]));
            assert_eq!(recovered["lastCompletedStepId"], "one");
            adapter.result(
                &instance,
                "kernel.run.completeStep",
                json!({"runId":"r","stepId":"two"}),
            );
        }
        assert_eq!(
            adapter.result(
                &instance,
                "kernel.fault.arm",
                json!({"point":point,"selector":{},"occurrence":1,"mode":"throw"})
            )["token"],
            "fault-2"
        );
    }
}

#[test]
fn production_grpc_dependency_graph_excludes_test_controls() {
    let output = Command::new("cargo")
        .args([
            "tree",
            "--offline",
            "-p",
            "tuvren-kernel-rust-grpc-service",
            "--edges",
            "normal",
            "--format",
            "{p} features={f}",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let graph = String::from_utf8(output.stdout).unwrap();
    let kernel_line = graph
        .lines()
        .find(|line| line.contains("tuvren-kernel-rust v"))
        .expect("kernel dependency in production graph");
    let (_, features) = kernel_line.split_once(" features=").expect("feature list");
    assert!(
        !features.split(',').any(|feature| feature == "conformance"),
        "{kernel_line}"
    );
}

#[test]
fn syscall_capabilities_do_not_claim_legacy_scope_and_restart_composites() {
    let mut adapter = Adapter::new();
    let initialized = adapter.request(
        "initialize",
        json!({"packetId":"test","planVersion":"0.1.0"}),
    );
    let capabilities = initialized["result"]["capabilities"].as_array().unwrap();
    for capability in ["kernel.scope-isolation", "kernel.restart-recovery"] {
        assert!(!capabilities.contains(&json!(capability)), "{capability}");
    }
    let instance = adapter.instance();
    for operation in [
        "kernel.logical.recovery-state",
        "kernel.reclamation.erasure-probe",
        "kernel.reclamation.reclaim-probe",
        "kernel.run-liveness.lease-renewal",
    ] {
        let response = adapter.call(&instance, operation, json!({}));
        assert_eq!(
            response["error"]["code"], "adapter_operation_not_implemented",
            "{response}"
        );
    }
}

#[test]
fn wrong_hash_mutant_requires_explicit_selection_and_proves_native_activation() {
    let mut adapter = Adapter::new();
    let activation = adapter.request(
        "dispatch",
        json!({"operation":"kernel.mutant.activation","input":{}}),
    );
    assert_eq!(
        activation["result"]["value"]["result"]["activation"]["activated"],
        false
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_tuvren-kernel-rust-conformance-adapter"))
        .arg("--mutant-from-env")
        .env("TUVREN_KERNEL_MUTANT", "kernel.wrong-opaque-object-hash")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut mutant = Adapter {
        input: child.stdin.take().unwrap(),
        output: BufReader::new(child.stdout.take().unwrap()),
        child,
    };
    let instance = mutant.instance();
    let hash = mutant.result(
        &instance,
        "kernel.store.put",
        json!({"blob":{"$bytes":"01"}}),
    );
    assert_eq!(hash, tuvren_kernel_rust::hash_bytes_to_hex(&[1, 0]));
    assert_eq!(
        mutant.result(&instance, "kernel.store.get", json!({"hash":hash})),
        json!({"$bytes":"01"})
    );
    let activation = mutant.request(
        "dispatch",
        json!({"operation":"kernel.mutant.activation","input":{}}),
    );
    assert_eq!(
        activation["result"]["value"]["result"]["activation"],
        json!({"mutantId":"kernel.wrong-opaque-object-hash","signal":"mutant.wrong-opaque-object-hash.entered","activated":true,"activationCount":1})
    );
}

#[test]
fn every_memory_plan_syscall_has_a_native_binding() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    for family in [
        "reclamation",
        "scope-isolation",
        "run-liveness",
        "restart-recovery",
    ] {
        let path = format!(
            "{}/../../spec/conformance/kernel/plans/kernel-{family}-syscall.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let plan: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for check in plan["checks"].as_array().unwrap() {
            for step in check["steps"].as_array().unwrap() {
                let operation = step["operation"].as_str().unwrap();
                let response = adapter.call(&instance, operation, json!({}));
                assert_ne!(
                    response["error"]["code"], "adapter_operation_not_implemented",
                    "{family} {operation}: {response}"
                );
                assert_ne!(
                    response["error"]["code"], "adapter_invalid_instance",
                    "{family} {operation}: {response}"
                );
            }
        }
    }
}
