use std::collections::BTreeSet;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::{correlated_id, error_response, handle_line, host_syscalls::Syscalls};

#[derive(Default)]
struct QueueState {
    issued: u64,
    completed: u64,
    finished: BTreeSet<u64>,
}

#[derive(Default)]
struct Queue {
    state: Mutex<QueueState>,
    changed: Condvar,
}

impl Queue {
    fn issue(&self) -> u64 {
        let mut state = self.state.lock().expect("queue lock poisoned");
        state.issued += 1;
        state.issued
    }

    fn wait(&self, ticket: u64, bounded: bool) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        if bounded {
            self.changed
                .wait_timeout_while(state, Duration::from_millis(1000), |state| {
                    state.completed + 1 < ticket
                })
                .is_ok_and(|(state, _)| state.completed + 1 >= ticket)
        } else {
            self.changed
                .wait_while(state, |state| state.completed + 1 < ticket)
                .is_ok()
        }
    }

    fn finish(&self, ticket: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.finished.insert(ticket);
            while {
                let next = state.completed + 1;
                state.finished.remove(&next)
            } {
                state.completed += 1;
            }
            self.changed.notify_all();
        }
    }
}

pub(crate) fn serve(syscalls: Arc<Syscalls>) {
    let queue = Arc::new(Queue::default());
    let mut tasks: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let output = Arc::new(Mutex::new(io::stdout()));
    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let response = error_response(
                    Value::Null,
                    "adapter_stdin_failed",
                    &format!("failed to read adapter stdin: {error}"),
                );
                if let Ok(mut output) = output.lock() {
                    let _ = writeln!(output, "{response}");
                }
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let mut index = 0;
        while index < tasks.len() {
            if tasks[index].is_finished() {
                let _ = tasks.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        let parsed = serde_json::from_str::<Value>(&line).ok();
        let method = parsed
            .as_ref()
            .and_then(|value| value.get("method"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let blocking = matches!(
            method,
            "dispatch"
                | "createInstance"
                | "events"
                | "inspectState"
                | "setClock"
                | "armFault"
                | "destroyInstance"
                | "shutdown"
        );
        let bounded = matches!(method, "destroyInstance" | "shutdown");
        let ticket = blocking.then(|| queue.issue());
        let prepared = if method == "awaitOperation" {
            parsed
                .as_ref()
                .and_then(|value| value.get("params"))
                .and_then(|params| params.get("operationHandle"))
                .and_then(Value::as_str)
                .filter(|handle| !handle.is_empty())
                .map(|handle| syscalls.operation(handle))
        } else {
            None
        };
        let syscalls = syscalls.clone();
        let output = output.clone();
        let queue = queue.clone();
        tasks.push(std::thread::spawn(move || {
            let ready = ticket.is_none_or(|ticket| queue.wait(ticket, bounded));
            let response = if ready {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_line(&line, &syscalls, prepared)
                }))
                .unwrap_or_else(|_| {
                    error_response(
                        correlated_id(&line),
                        "adapter_host_error",
                        "request worker panicked",
                    )
                })
            } else {
                error_response(
                    correlated_id(&line),
                    "adapter_instance_busy",
                    "pending blocking dispatch exceeded lifecycle deadline",
                )
            };
            if let Ok(mut output) = output.lock() {
                let _ = writeln!(output, "{response}");
                let _ = output.flush();
            }
            if let Some(ticket) = ticket {
                queue.finish(ticket);
            }
        }));
    }
    for task in tasks {
        let _ = task.join();
    }
}
