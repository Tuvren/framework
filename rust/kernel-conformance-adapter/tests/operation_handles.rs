use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use serde_json::{Value, json};

struct Adapter {
    child: Child,
    input: ChildStdin,
    responses: Receiver<Value>,
    next_id: u64,
    pending: BTreeMap<u64, Value>,
}

impl Adapter {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tuvren-kernel-rust-conformance-adapter"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if sender.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            responses,
            next_id: 0,
            pending: BTreeMap::new(),
        }
    }

    fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let frame = json!({"jsonrpc":"2.0", "id":self.next_id, "method":method, "params":params});
        writeln!(self.input, "{frame}").unwrap();
        self.input.flush().unwrap();
        self.next_id
    }

    fn receive(&self) -> Value {
        self.responses
            .recv_timeout(Duration::from_secs(4))
            .expect("timed out waiting for adapter response")
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.receive_for(id)
    }

    fn receive_for(&mut self, id: u64) -> Value {
        if let Some(response) = self.pending.remove(&id) {
            return response;
        }
        loop {
            let response = self.receive();
            let response_id = response["id"].as_u64().expect("response id");
            if response_id == id {
                return response;
            }
            self.pending.insert(response_id, response);
        }
    }

    fn dispatch(&mut self, instance: &Value, operation: &str, input: Value) -> Value {
        let response = self.request(
            "dispatch",
            json!({"instance":instance,"operation":operation,"input":input}),
        );
        assert_eq!(response["result"]["kind"], "result", "{response}");
        response["result"]["value"]["result"].clone()
    }

    fn instance(&mut self) -> Value {
        let instance = self.request("createInstance", json!({"input":{}}))["result"].clone();
        for domain in ["backend", "worker"] {
            self.dispatch(
                &instance,
                "kernel.clock.set",
                json!({"domain":domain,"nowMs":0}),
            );
        }
        instance
    }

    fn start(&mut self, instance: &Value, participant: &str, byte: &str) -> Value {
        let response = self.request("startOperation", json!({"instance":instance,"operation":"kernel.store.put","arguments":{"barrierParticipant":participant,"blob":{"$bytes":byte}}}));
        assert!(
            response["result"]["operationHandle"].is_string(),
            "{response}"
        );
        response["result"]["operationHandle"].clone()
    }

    fn arm(&mut self, instance: &Value) {
        self.dispatch(instance, "kernel.barrier.arm", json!({"barrierId":"writers","seam":"kernel.persistence.before-transact","participants":["first","second"]}));
    }

    fn wait(&mut self, instance: &Value, handle: &Value) {
        let receipt = self.dispatch(
            instance,
            "kernel.barrier.wait",
            json!({"barrierId":"writers","operationHandle":handle,"timeoutMs":1000}),
        );
        assert_eq!(
            receipt,
            json!({"barrierId":"writers","seam":"kernel.persistence.before-transact","operationHandle":handle})
        );
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn both_writers_reach_the_native_seam_and_the_host_answers_while_awaiting() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    adapter.arm(&instance);
    let first = adapter.start(&instance, "first", "01");
    let second = adapter.start(&instance, "second", "02");
    assert_ne!(first, second);
    adapter.wait(&instance, &first);
    adapter.wait(&instance, &second);
    assert_eq!(
        adapter.dispatch(
            &instance,
            "kernel.store.has",
            json!({"hash":tuvren_kernel_rust::hash_bytes_to_hex(&[1])})
        ),
        false
    );
    let third = adapter.start(&instance, "unrelated", "03");
    assert_eq!(
        adapter.request("awaitOperation", json!({"operationHandle":third}))["result"]["kind"],
        "result"
    );

    let pending = adapter.send("awaitOperation", json!({"operationHandle":first}));
    let inspection = adapter.request("inspectState", json!({"instance":instance,"query":{}}));
    assert_eq!(inspection["result"], Value::Null);
    adapter.dispatch(
        &instance,
        "kernel.barrier.release",
        json!({"barrierId":"writers","operationHandles":[first,second]}),
    );
    let completed = adapter.receive_for(pending);
    assert_eq!(completed["id"], pending, "{completed}");
    assert_eq!(completed["result"]["kind"], "result");
    let second_outcome = adapter.request("awaitOperation", json!({"operationHandle":second}));
    assert_eq!(second_outcome["result"]["kind"], "result");
    adapter.dispatch(&instance, "kernel.barrier.arm", json!({"barrierId":"next","seam":"kernel.persistence.before-transact","participants":["a","b"]}));
}

#[test]
fn cancellation_at_the_seam_prevents_the_write_and_outcomes_are_repeatable() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    adapter.arm(&instance);
    let first = adapter.start(&instance, "first", "06");
    let second = adapter.start(&instance, "second", "07");
    adapter.wait(&instance, &first);
    adapter.wait(&instance, &second);
    assert_eq!(
        adapter.request(
            "cancelOperation",
            json!({"operationHandle":first,"reason":"cancel at gate"})
        )["result"],
        Value::Null
    );
    adapter.dispatch(
        &instance,
        "kernel.barrier.release",
        json!({"barrierId":"writers","operationHandles":[first,second]}),
    );
    let result = adapter.request("awaitOperation", json!({"operationHandle":first}));
    assert_eq!(result["result"]["kind"], "error", "{result}");
    assert_eq!(result["result"]["error"]["message"], "cancel at gate");
    assert_eq!(
        adapter.request("awaitOperation", json!({"operationHandle":first}))["result"],
        result["result"]
    );
    let hash = tuvren_kernel_rust::hash_bytes_to_hex(&[6]);
    assert_eq!(
        adapter.dispatch(&instance, "kernel.store.has", json!({"hash":hash})),
        false
    );
}

#[test]
fn destroy_cancels_and_drains_held_work() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    adapter.arm(&instance);
    let first = adapter.start(&instance, "first", "08");
    adapter.wait(&instance, &first);
    let pending = adapter.send("awaitOperation", json!({"operationHandle":first}));
    let destroy = adapter.send("destroyInstance", json!({"instance":instance}));
    let responses = [adapter.receive(), adapter.receive()];
    let completed = responses.iter().find(|v| v["id"] == pending).unwrap();
    assert_eq!(completed["result"]["kind"], "error", "{completed}");
    assert_eq!(
        completed["result"]["error"]["message"],
        "adapter instance destroyed"
    );
    let destroyed = responses.iter().find(|v| v["id"] == destroy).unwrap();
    assert_eq!(destroyed["result"], Value::Null, "{destroyed}");
    assert!(
        adapter.request("awaitOperation", json!({"operationHandle":first}))["error"].is_object()
    );
}

#[test]
fn shutdown_cancels_held_work_in_every_instance() {
    let mut adapter = Adapter::new();
    let first_instance = adapter.instance();
    let second_instance = adapter.instance();
    adapter.arm(&first_instance);
    adapter.arm(&second_instance);
    let first = adapter.start(&first_instance, "first", "08");
    let second = adapter.start(&second_instance, "first", "09");
    adapter.wait(&first_instance, &first);
    adapter.wait(&second_instance, &second);
    let first_await = adapter.send("awaitOperation", json!({"operationHandle":first}));
    let second_await = adapter.send("awaitOperation", json!({"operationHandle":second}));
    let shutdown = adapter.send("shutdown", json!({}));
    for id in [first_await, second_await] {
        let response = adapter.receive_for(id);
        assert_eq!(response["result"]["kind"], "error", "{response}");
        assert_eq!(
            response["result"]["error"]["message"],
            "adapter instance destroyed"
        );
    }
    assert_eq!(adapter.receive_for(shutdown)["result"], Value::Null);
    for handle in [first, second] {
        assert!(
            adapter.request("awaitOperation", json!({"operationHandle":handle}))["error"]
                .is_object()
        );
    }
}

#[test]
fn malformed_correlated_requests_do_not_poison_the_session() {
    let mut adapter = Adapter::new();
    writeln!(
        adapter.input,
        "{{\"jsonrpc\":\"2.0\",\"id\":41,\"method\":\"events\",\"params\":{{\"x\":1,\"x\":2}}}}"
    )
    .unwrap();
    adapter.input.flush().unwrap();
    let malformed = adapter.receive();
    assert_eq!(malformed["id"], 41, "{malformed}");
    assert!(malformed["error"].is_object());
    let valid = adapter.request(
        "initialize",
        json!({"packetId":"test","planVersion":"0.1.0"}),
    );
    assert_eq!(valid["result"]["adapterId"], "rust-kernel");
}

#[test]
fn protocol_clock_and_fault_controls_use_the_instance_test_seams() {
    let mut adapter = Adapter::new();
    let instance = adapter.request("createInstance", json!({"input":{}}))["result"].clone();
    for domain in ["backend", "worker"] {
        let response = adapter.request(
            "setClock",
            json!({"instance":instance,"domain":domain,"nowMs":42}),
        );
        assert_eq!(response["result"], Value::Null, "{response}");
        assert!(response.get("error").is_none(), "{response}");
    }
    let armed = adapter.request("armFault", json!({"instance":instance,"point":"before-commit","selector":{},"occurrence":1,"mode":"throw"}));
    assert_eq!(armed["result"]["token"], "fault-1", "{armed}");
    let outcome = adapter.request("dispatch", json!({"instance":instance,"operation":"kernel.store.put","input":{"blob":{"$bytes":"01"}}}));
    assert_eq!(
        outcome["result"]["error"]["code"], "kernel_persistence_fault_injected",
        "{outcome}"
    );
    assert_eq!(
        outcome["result"]["error"]["details"]["token"],
        armed["result"]["token"]
    );
}

#[test]
fn cancellation_after_completion_preserves_the_outcome() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    let handle = adapter.start(&instance, "other", "0a");
    let outcome =
        adapter.request("awaitOperation", json!({"operationHandle":handle}))["result"].clone();
    assert_eq!(outcome["kind"], "result");
    adapter.request(
        "cancelOperation",
        json!({"operationHandle":handle,"reason":"already complete"}),
    );
    assert_eq!(
        adapter.request("awaitOperation", json!({"operationHandle":handle}))["result"],
        outcome
    );
}

#[test]
fn lifecycle_deadline_does_not_destroy_an_instance_with_blocking_work() {
    let mut adapter = Adapter::new();
    let instance = adapter.instance();
    adapter.arm(&instance);
    let waiting = adapter.send("dispatch", json!({"instance":instance,"operation":"kernel.barrier.wait","input":{"barrierId":"writers","operationHandle":"missing","timeoutMs":2000}}));
    let destroy = adapter.send("destroyInstance", json!({"instance":instance}));
    let response = adapter.receive_for(destroy);
    assert_eq!(
        response["error"]["code"], "adapter_instance_busy",
        "{response}"
    );
    assert!(adapter.receive_for(waiting)["error"].is_object());
    assert_eq!(
        adapter.dispatch(&instance, "kernel.store.has", json!({"hash":"missing"})),
        false
    );
    assert_eq!(
        adapter.request("destroyInstance", json!({"instance":instance}))["result"],
        Value::Null
    );
}
