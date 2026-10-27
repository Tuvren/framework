use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tuvren_kernel_rust::{
    InMemoryKernel, KernelError, LeasedRunCreateInput, ObserveResult, RunCompletionStatus,
    ThreadListOptions,
};

use tuvren_kernel_rust::testkit::barrier::{BarrierControl, OperationContext};
use tuvren_kernel_rust::testkit::mutants::KernelMutant;
use tuvren_kernel_rust::testkit::{ClockDomain, FaultRequest, KernelTestControls};

use crate::observation_encoding::{self as encoding, EncodingResult, MAX_SAFE_INTEGER, invalid};
use crate::syscall_values::{
    self as values, Observation, field, list, number, optional_record, optional_text, text,
};
use crate::{AdapterErrorEnvelope, OperationOutcome, adapter_error};

pub(crate) enum BridgeError {
    Adapter(AdapterErrorEnvelope),
    Native(KernelError),
}
impl From<AdapterErrorEnvelope> for BridgeError {
    fn from(v: AdapterErrorEnvelope) -> Self {
        Self::Adapter(v)
    }
}
impl From<KernelError> for BridgeError {
    fn from(v: KernelError) -> Self {
        Self::Native(v)
    }
}
type CallResult = Result<Value, BridgeError>;
type Binding = fn(&InMemoryKernel, &Value) -> CallResult;

macro_rules! routing {
    ($($operation:literal => $binding:expr),* $(,)?) => {
        &[$(($operation, $binding)),*]
    };
}

const BINDINGS: &[(&str, Binding)] = routing![
    "kernel.store.put" => |k, a| {
        Ok(k.store_put(
            encoding::decode_bytes(field(a, "blob")?)?,
            optional_text(a, "mediaType")?,
        )?
        .encode()?)
    },
    "kernel.store.get" => |k, a| {
        Ok(k.store_get(text(a, "hash")?)?
            .map(|v| encoding::bytes(&v))
            .unwrap_or(Value::Null))
    },
    "kernel.store.has" => |k, a| {
        Ok(k.store_has(text(a, "hash")?)?.encode()?)
    },
    "kernel.schema.register" => |k, a| {
        Ok(k.schema_register(values::schema(field(a, "schema")?)?)?
            .encode()?)
    },
    "kernel.schema.get" => |k, a| {
        Ok(k.schema_get(text(a, "schemaId")?)?.encode()?)
    },
    "kernel.tree.create" => |k, a| {
        Ok(k.tree_create(
            text(a, "schemaId")?,
            values::changes(field(a, "changes")?)?,
            optional_text(a, "baseTurnTreeHash")?.as_deref(),
        )?
        .encode()?)
    },
    "kernel.tree.incorporate" => |k, a| {
        Ok(k.tree_incorporate(
            text(a, "baseTurnTreeHash")?,
            &list(a, "stagedResults")?
                .iter()
                .map(values::staged)
                .collect::<EncodingResult<Vec<_>>>()?,
        )?
        .encode()?)
    },
    "kernel.tree.diff" => |k, a| {
        Ok(k.tree_diff(text(a, "treeHashA")?, text(a, "treeHashB")?)?
            .encode()?)
    },
    "kernel.tree.resolve" => |k, a| {
        Ok(k.tree_resolve(text(a, "treeHash")?, text(a, "path")?)?
            .encode()?)
    },
    "kernel.tree.manifest" => |k, a| {
        Ok(k.tree_manifest(text(a, "treeHash")?)?.encode()?)
    },
    "kernel.node.get" => |k, a| {
        Ok(k.node_get(text(a, "hash")?)?.encode()?)
    },
    "kernel.node.walkBack" => |k, a| {
        Ok(k.node_walk_back(text(a, "fromHash")?)?.encode()?)
    },
    "kernel.thread.create" => |k, a| {
        Ok(k.thread_create(
            text(a, "threadId")?,
            text(a, "schemaId")?,
            text(a, "initialBranchId")?,
        )?
        .encode()?)
    },
    "kernel.thread.get" => |k, a| {
        Ok(k.thread_get(text(a, "threadId")?)?.encode()?)
    },
    "kernel.thread.list" => |k, a| {
        let options = a.get("options").cloned().unwrap_or(json!({}));
        let cursor = options
            .get("cursor")
            .map(|v| {
                serde_json::from_str(
                    v.as_str()
                        .ok_or_else(|| invalid("expected opaque cursor"))?,
                )
                .map_err(|_| invalid("invalid native thread cursor"))
            })
            .transpose()?;
        let limit = options
            .get("limit")
            .map(|_| {
                number(&options, "limit").and_then(|n| {
                    usize::try_from(n)
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| invalid("limit must be positive"))
                })
            })
            .transpose()?;
        let filter_schema_id = options
            .get("filter")
            .map(|filter| optional_text(filter, "schemaId"))
            .transpose()?
            .flatten();
        let (threads, cursor) = k.thread_list(ThreadListOptions {
            limit,
            cursor,
            filter_schema_id,
        })?;
        let mut result = json!({"threads":threads.encode()?});
        if let Some(cursor) = cursor {
            result["nextCursor"] = json!(
                serde_json::to_string(&cursor).map_err(|_| invalid("invalid native cursor"))?
            );
        }
        Ok(result)
    },
    "kernel.branch.create" => |k, a| {
        Ok(k.branch_create(
            text(a, "branchId")?,
            text(a, "threadId")?,
            text(a, "fromTurnNodeHash")?,
        )?
        .encode()?)
    },
    "kernel.branch.get" => |k, a| {
        Ok(k.branch_get(text(a, "branchId")?)?.encode()?)
    },
    "kernel.branch.list" => |k, a| {
        Ok(json!(k.branch_list(text(a, "threadId")?)?))
    },
    "kernel.branch.setHead" => |k, a| {
        Ok(
            k.branch_set_head(text(a, "branchId")?, text(a, "turnNodeHash")?)?
                .encode()?,
        )
    },
    "kernel.turn.create" => |k, a| {
        Ok(k.turn_create(
            text(a, "turnId")?,
            text(a, "threadId")?,
            text(a, "branchId")?,
            a.get("parentTurnId").filter(|v| !v.is_null()).map(|_| text(a, "parentTurnId").map(str::to_owned)).transpose()?,
            text(a, "startTurnNodeHash")?,
        )?
        .encode()?)
    },
    "kernel.turn.get" => |k, a| {
        Ok(k.turn_get(text(a, "turnId")?)?.encode()?)
    },
    "kernel.turn.updateHead" => |k, a| {
        k.turn_update_head(text(a, "turnId")?, text(a, "headTurnNodeHash")?)?;
        Ok(json!({}))
    },
    "kernel.staging.stage" => |k, a| {
        let (hash, staged) = k.staging_stage(
            text(a, "runId")?,
            encoding::decode_bytes(field(a, "blob")?)?,
            text(a, "taskId")?,
            text(a, "objectType")?,
            values::status(text(a, "status")?)?,
            optional_record(a, "interruptPayload")?,
        )?;
        Ok(json!({"objectHash":hash,"stagedResult":staged.encode()?}))
    },
    "kernel.staging.current" => |k, a| {
        Ok(k.staging_current(text(a, "runId")?)?.encode()?)
    },
    "kernel.run.create" => |k, a| {
        Ok(k.run_create(
            text(a, "runId")?,
            text(a, "turnId")?,
            text(a, "branchId")?,
            text(a, "schemaId")?,
            text(a, "startTurnNodeHash")?,
            list(a, "steps")?
                .iter()
                .map(values::step)
                .collect::<EncodingResult<Vec<_>>>()?,
        )?
        .encode()?)
    },
    "kernel.run.beginStep" => |k, a| {
        Ok(k.run_begin_step(text(a, "runId")?, text(a, "stepId")?)?
            .encode()?)
    },
    "kernel.run.completeStep" => |k, a| {
        let observations = a
            .get("observeResults")
            .map(|_| {
                list(a, "observeResults")?
                    .iter()
                    .map(|v| {
                        Ok(ObserveResult {
                            annotations: list(v, "annotations")?
                                .iter()
                                .map(values::annotation)
                                .collect::<EncodingResult<_>>()?,
                            signals: list(v, "signals")?
                                .iter()
                                .map(encoding::decode_record)
                                .collect::<EncodingResult<_>>()?,
                        })
                    })
                    .collect::<EncodingResult<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        let (checkpointed, hash) = k.run_complete_step(
            text(a, "runId")?,
            text(a, "stepId")?,
            optional_text(a, "eventHash")?,
            observations,
            optional_text(a, "treeHash")?,
        )?;
        let mut result = json!({"checkpointed":checkpointed});
        if let Some(hash) = hash {
            result["turnNodeHash"] = json!(hash);
        }
        Ok(result)
    },
    "kernel.run.complete" => |k, a| {
        let status = match text(a, "status")? {
            "completed" => RunCompletionStatus::Completed,
            "paused" => RunCompletionStatus::Paused,
            "failed" => RunCompletionStatus::Failed,
            _ => return Err(invalid("invalid completion status").into()),
        };
        let hash = k.run_complete(text(a, "runId")?, status, optional_text(a, "eventHash")?)?;
        Ok(match hash {
            Some(hash) => json!({"turnNodeHash":hash}),
            None => json!({}),
        })
    },
    "kernel.run.recover" => |k, a| {
        Ok(k.run_recover(text(a, "runId")?)?.encode()?)
    },
    "kernel.runLiveness.createLeasedRun" => |k, a| {
        let input = field(a, "input")?;
        Ok(k.run_liveness_create_leased_run(LeasedRunCreateInput {
            run_id: text(input, "runId")?.into(),
            turn_id: text(input, "turnId")?.into(),
            branch_id: text(input, "branchId")?.into(),
            schema_id: text(input, "schemaId")?.into(),
            start_turn_node_hash: text(input, "startTurnNodeHash")?.into(),
            execution_owner_id: text(input, "executionOwnerId")?.into(),
            lease_expires_at_ms: number(input, "leaseExpiresAtMs")?,
            steps: list(input, "steps")?.iter().map(values::step).collect::<EncodingResult<_>>()?,
        })?.encode()?)
    },
    "kernel.runLiveness.renewLease" => |k, a| {
        let lease = k.run_liveness_renew_lease(text(a, "runId")?, text(a, "executionOwnerId")?, text(a, "fencingToken")?, number(a, "nextLeaseExpiresAtMs")?)?;
        Ok(json!({"fencingToken":lease.fencing_token.encode()?,"leaseExpiresAtMs":lease.lease_expires_at_ms.encode()?}))
    },
    "kernel.runLiveness.listExpired" => |k, a| {
        Ok(k.run_liveness_list_expired(number(a, "nowMs")?)?.encode()?)
    },
    "kernel.runLiveness.preemptExpired" => |k, a| {
        Ok(k.run_liveness_preempt_expired(text(a, "runId")?, text(a, "preemptingOwnerId")?, number(a, "nowMs")?, text(a, "reason")?)?.encode()?)
    },
    "kernel.maintenance.reclaim" => |k, a| {
        let now = a.get("options").and_then(|options| options.get("nowMs").map(|_| number(options, "nowMs"))).transpose()?;
        Ok(k.maintenance_reclaim_at(now)?.encode()?)
    },
    "kernel.verdicts.compose" => |k, a| {
        Ok(k.verdicts_compose(
            list(a, "verdicts")?
                .iter()
                .map(values::verdict)
                .collect::<EncodingResult<Vec<_>>>()?,
        )?
        .encode()?)
    },
];

#[derive(Default)]
struct Lifecycle {
    closing: bool,
    in_flight: usize,
    started: usize,
}

struct Instance {
    kernel: Mutex<Option<InMemoryKernel>>,
    controls: KernelTestControls,
    barrier: BarrierControl,
    lifecycle: Mutex<Lifecycle>,
    changed: Condvar,
}

struct InFlight {
    instance: Arc<Instance>,
    started: bool,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut state) = self.instance.lifecycle.lock() {
            state.in_flight -= 1;
            if self.started {
                state.started -= 1;
            }
            self.instance.changed.notify_all();
        }
    }
}

impl Instance {
    fn begin(self: &Arc<Self>, started: bool) -> Result<InFlight, AdapterErrorEnvelope> {
        let mut state = self
            .lifecycle
            .lock()
            .map_err(|_| host_error("instance lock poisoned"))?;
        if state.closing {
            return Err(host_error("syscall requires a live adapter instance"));
        }
        state.in_flight += 1;
        if started {
            state.started += 1;
        }
        Ok(InFlight {
            instance: self.clone(),
            started,
        })
    }

    fn wait_for(&self, started_only: bool) -> Result<(), AdapterErrorEnvelope> {
        let state = self
            .lifecycle
            .lock()
            .map_err(|_| host_error("instance lock poisoned"))?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, Duration::from_millis(1000), |state| {
                if started_only {
                    state.started != 0
                } else {
                    state.in_flight != 0
                }
            })
            .map_err(|_| host_error("instance lock poisoned"))?;
        if if started_only {
            state.started != 0
        } else {
            state.in_flight != 0
        } {
            let message = if started_only {
                "started operations did not stop before destruction deadline"
            } else {
                "in-flight dispatch exceeded destruction deadline"
            };
            return Err(adapter_error("adapter_instance_busy", message, None));
        }
        Ok(())
    }
}

pub(crate) struct Operation {
    instance: String,
    context: OperationContext,
    outcome: Mutex<Option<Result<OperationOutcome, AdapterErrorEnvelope>>>,
    changed: Condvar,
}

#[derive(Default)]
struct Registry {
    instances: BTreeMap<String, Arc<Instance>>,
    operations: BTreeMap<String, Arc<Operation>>,
    next_instance: u64,
    next_operation: u64,
}

#[derive(Default)]
pub(crate) struct Syscalls {
    registry: Mutex<Registry>,
    mutant: Option<KernelMutant>,
}

fn host_error(message: &str) -> AdapterErrorEnvelope {
    adapter_error("adapter_host_error", message, None)
}

impl Syscalls {
    pub(crate) fn configured() -> Result<Self, String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.iter().any(|arg| arg != "--mutant-from-env") {
            return Err("unsupported Rust adapter argument".into());
        }
        let mutant = if args.iter().any(|arg| arg == "--mutant-from-env") {
            let id = std::env::var("TUVREN_KERNEL_MUTANT")
                .map_err(|_| "TUVREN_KERNEL_MUTANT required")?;
            Some(KernelMutant::select(&id).map_err(|error| error.payload.message)?)
        } else {
            None
        };
        Ok(Self {
            mutant,
            ..Self::default()
        })
    }

    pub(crate) fn create(&self) -> Result<String, AdapterErrorEnvelope> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?;
        registry.next_instance += 1;
        let handle = format!("rust-kernel-{}", registry.next_instance);
        registry.instances.insert(
            handle.clone(),
            Arc::new(Instance {
                kernel: Mutex::new(None),
                controls: KernelTestControls::with_mutant(self.mutant.clone()),
                barrier: BarrierControl::default(),
                lifecycle: Mutex::new(Lifecycle::default()),
                changed: Condvar::new(),
            }),
        );
        Ok(handle)
    }

    fn instance(&self, handle: &Value) -> Result<Arc<Instance>, AdapterErrorEnvelope> {
        self.registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?
            .instances
            .get(handle.as_str().unwrap_or_default())
            .cloned()
            .ok_or_else(|| {
                adapter_error(
                    "adapter_invalid_instance",
                    "syscall requires a live adapter instance",
                    None,
                )
            })
    }

    pub(crate) fn destroy(&self, handle: &Value) -> Result<(), AdapterErrorEnvelope> {
        let Some(key) = handle.as_str() else {
            return Ok(());
        };
        let instance = match self.instance(handle) {
            Ok(instance) => instance,
            Err(_) => return Ok(()),
        };
        {
            let mut lifecycle = instance
                .lifecycle
                .lock()
                .map_err(|_| host_error("instance lock poisoned"))?;
            if lifecycle.closing {
                return Err(adapter_error(
                    "adapter_instance_busy",
                    "instance destruction already in progress",
                    None,
                ));
            }
            lifecycle.closing = true;
        }
        let operations: Vec<_> = self
            .registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?
            .operations
            .values()
            .filter(|operation| operation.instance == key)
            .cloned()
            .collect();
        for operation in &operations {
            operation.context.cancel("adapter instance destroyed");
        }
        let result = instance.wait_for(true).and_then(|()| {
            instance.barrier.close();
            instance.wait_for(false)
        });
        if let Err(error) = result {
            if let Ok(mut lifecycle) = instance.lifecycle.lock() {
                lifecycle.closing = false;
            }
            return Err(error);
        }
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?;
        registry.instances.remove(key);
        registry
            .operations
            .retain(|_, operation| operation.instance != key);
        Ok(())
    }

    pub(crate) fn shutdown(self: &Arc<Self>) -> Result<(), AdapterErrorEnvelope> {
        let handles: Vec<_> = self
            .registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?
            .instances
            .keys()
            .cloned()
            .collect();
        let count = handles.len();
        let (sender, receiver) = std::sync::mpsc::channel();
        for handle in handles {
            let syscalls = self.clone();
            let sender = sender.clone();
            std::thread::Builder::new()
                .spawn(move || {
                    let _ = sender.send(syscalls.destroy(&json!(handle)));
                })
                .map_err(|error| {
                    host_error(&format!("cannot start destruction worker: {error}"))
                })?;
        }
        drop(sender);
        for _ in 0..count {
            receiver
                .recv()
                .map_err(|_| host_error("destruction worker failed"))??;
        }
        Ok(())
    }

    pub(crate) fn start(
        self: &Arc<Self>,
        operation: String,
        input: Value,
        handle: Value,
    ) -> Result<Value, AdapterErrorEnvelope> {
        if !Self::has(&operation) {
            return Err(host_error("unsupported syscall"));
        }
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?;
        let instance = registry
            .instances
            .get(handle.as_str().unwrap_or_default())
            .cloned()
            .ok_or_else(|| host_error("syscall requires a live adapter instance"))?;
        let guard = instance.begin(true)?;
        registry.next_operation += 1;
        let operation_handle = format!("rust-operation-{}", registry.next_operation);
        let context = instance.barrier.operation(operation_handle.clone());
        let task = Arc::new(Operation {
            instance: handle.as_str().unwrap_or_default().to_owned(),
            context,
            outcome: Mutex::new(None),
            changed: Condvar::new(),
        });
        registry
            .operations
            .insert(operation_handle.clone(), task.clone());
        drop(registry);
        let host = self.clone();
        let spawned = std::thread::Builder::new().spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Some(reason) = task.context.cancellation() {
                    return Err(adapter_error(
                        "operation_cancelled_before_entry",
                        &reason,
                        None,
                    ));
                }
                host.dispatch_instance(&instance, &operation, &input, Some(task.context.clone()))
            }))
            .unwrap_or_else(|_| Err(host_error("operation worker panicked")));
            if let Ok(mut outcome) = task.outcome.lock() {
                *outcome = Some(result);
                task.changed.notify_all();
            }
            drop(guard);
        });
        if let Err(error) = spawned {
            self.registry
                .lock()
                .map_err(|_| host_error("registry lock poisoned"))?
                .operations
                .remove(&operation_handle);
            return Err(host_error(&format!(
                "cannot start operation worker: {error}"
            )));
        }
        Ok(json!({"operationHandle":operation_handle}))
    }

    pub(crate) fn operation(&self, handle: &str) -> Result<Arc<Operation>, AdapterErrorEnvelope> {
        self.registry
            .lock()
            .map_err(|_| host_error("registry lock poisoned"))?
            .operations
            .get(handle)
            .cloned()
            .ok_or_else(|| host_error("unknown operation handle"))
    }

    pub(crate) fn await_operation(
        &self,
        handle: &str,
        prepared: Option<Result<Arc<Operation>, AdapterErrorEnvelope>>,
    ) -> Result<OperationOutcome, AdapterErrorEnvelope> {
        let operation = match prepared {
            Some(operation) => operation?,
            None => self.operation(handle)?,
        };
        let outcome = operation
            .outcome
            .lock()
            .map_err(|_| host_error("operation lock poisoned"))?;
        let outcome = operation
            .changed
            .wait_while(outcome, |outcome| outcome.is_none())
            .map_err(|_| host_error("operation lock poisoned"))?;
        outcome
            .as_ref()
            .cloned()
            .ok_or_else(|| host_error("missing operation outcome"))?
    }

    pub(crate) fn cancel(&self, handle: &str, reason: &str) -> Result<(), AdapterErrorEnvelope> {
        self.operation(handle)?.context.cancel(reason);
        Ok(())
    }

    pub(crate) fn protocol_control(
        &self,
        method: &str,
        params: &Value,
    ) -> Option<Result<Value, AdapterErrorEnvelope>> {
        let (_, (binding, null_result)) =
            PROTOCOL_CONTROLS.iter().find(|(name, _)| *name == method)?;
        Some((|| {
            let instance = self.instance(params.get("instance").unwrap_or(&Value::Null))?;
            let _guard = instance.begin(false)?;
            match bridge_outcome(binding(&instance, params))? {
                OperationOutcome::Result { value } => {
                    if *null_result {
                        Ok(Value::Null)
                    } else {
                        Ok(value["result"].clone())
                    }
                }
                OperationOutcome::Error { error } => Err(error),
            }
        })())
    }
    pub(crate) fn has(operation: &str) -> bool {
        BINDINGS.iter().any(|(name, _)| *name == operation)
            || CONTROLS.iter().any(|(name, _)| *name == operation)
            || PROCESS_CONTROLS.iter().any(|(name, _)| *name == operation)
    }
    pub(crate) fn dispatch(
        &self,
        operation: &str,
        input: &Value,
        handle: &Value,
    ) -> Result<OperationOutcome, AdapterErrorEnvelope> {
        if let Some((_, binding)) = PROCESS_CONTROLS.iter().find(|(name, _)| *name == operation) {
            return Ok(OperationOutcome::Result {
                value: json!({"result":binding(self)}),
            });
        }
        let instance = self.instance(handle)?;
        let _guard = instance.begin(false)?;
        self.dispatch_instance(&instance, operation, input, None)
    }

    fn dispatch_instance(
        &self,
        instance: &Instance,
        operation: &str,
        input: &Value,
        context: Option<OperationContext>,
    ) -> Result<OperationOutcome, AdapterErrorEnvelope> {
        if let Some((_, binding)) = PROCESS_CONTROLS.iter().find(|(name, _)| *name == operation) {
            return Ok(OperationOutcome::Result {
                value: json!({"result":binding(self)}),
            });
        }
        let result = if let Some((_, binding)) =
            BINDINGS.iter().find(|(name, _)| *name == operation)
        {
            let mut kernel_guard = instance
                .kernel
                .lock()
                .map_err(|_| host_error("kernel lock poisoned"))?;
            if kernel_guard.is_none() {
                *kernel_guard = Some(
                    InMemoryKernel::with_test_controls(instance.controls.clone()).map_err(
                        |error| adapter_error(&error.payload.code, &error.payload.message, None),
                    )?,
                );
            }
            let kernel = kernel_guard
                .as_ref()
                .ok_or_else(|| invalid("kernel initialization failed"))?
                .clone();
            drop(kernel_guard);
            let kernel = match context {
                Some(context) => {
                    if let Some(reason) = context.cancellation() {
                        return Err(adapter_error(
                            "operation_cancelled_before_entry",
                            &reason,
                            None,
                        ));
                    }
                    kernel.for_operation(context)
                }
                None => kernel,
            };
            binding(&kernel, input)
        } else if let Some((_, binding)) = CONTROLS.iter().find(|(name, _)| *name == operation) {
            binding(instance, input)
        } else {
            return Err(adapter_error(
                "adapter_operation_not_implemented",
                "unsupported syscall",
                None,
            ));
        };
        bridge_outcome(result)
    }
}

fn bridge_outcome(result: CallResult) -> Result<OperationOutcome, AdapterErrorEnvelope> {
    match result {
        Ok(value) => Ok(OperationOutcome::Result {
            value: json!({"result":value}),
        }),
        Err(BridgeError::Adapter(error)) => Err(error),
        Err(BridgeError::Native(source)) => Ok(OperationOutcome::Error {
            error: AdapterErrorEnvelope {
                code: source.payload.code,
                message: source.payload.message,
                details: source
                    .payload
                    .details
                    .as_ref()
                    .map(encoding::encode_error_details)
                    .transpose()?,
            },
        }),
    }
}

type ControlBinding = fn(&Instance, &Value) -> CallResult;
const PROTOCOL_CONTROLS: &[(&str, (ControlBinding, bool))] = routing![
    "setClock" => (set_clock, true),
    "armFault" => (arm_fault, false),
];

fn set_clock(instance: &Instance, a: &Value) -> CallResult {
    let domain: ClockDomain = serde_json::from_value(field(a, "domain")?.clone())
        .map_err(|_| invalid("invalid clock domain"))?;
    instance
        .controls
        .set_clock(domain, number(a, "nowMs")?)
        .map_err(|error| adapter_error(&error.payload.code, &error.payload.message, None))?;
    Ok(json!({}))
}

fn arm_fault(instance: &Instance, a: &Value) -> CallResult {
    let mut request = a
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("expected fault request"))?;
    request.remove("instance");
    let request: FaultRequest = serde_json::from_value(Value::Object(request))
        .map_err(|_| invalid("invalid fault request"))?;
    if request.occurrence == 0 || request.occurrence > MAX_SAFE_INTEGER.cast_unsigned() {
        return Err(invalid("fault occurrence requires a positive safe integer").into());
    }
    Ok(json!({"token":instance.controls.arm_fault(request)?}))
}

const CONTROLS: &[(&str, ControlBinding)] = routing![
    "kernel.barrier.arm" => |instance, a| {
        let id = text(a, "barrierId")?;
        let seam = text(a, "seam")?;
        let participants = list(a, "participants")?.iter().map(|value| value.as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| invalid("invalid barrier participant"))).collect::<EncodingResult<Vec<_>>>()?;
        instance.barrier.arm(id, seam, &participants).map_err(|message| host_error(&message))?;
        Ok(json!({"barrierId":id,"seam":seam}))
    },
    "kernel.barrier.wait" => |instance, a| {
        let id = text(a, "barrierId")?;
        let handle = text(a, "operationHandle")?;
        let timeout = u64::try_from(number(a, "timeoutMs")?).ok().filter(|value| *value > 0).ok_or_else(|| invalid("invalid receipt timeout"))?;
        let receipt = instance.barrier.wait(id, handle, Duration::from_millis(timeout)).map_err(|message| host_error(&message))?;
        Ok(json!(receipt))
    },
    "kernel.barrier.release" => |instance, a| {
        let id = text(a, "barrierId")?;
        let handles = list(a, "operationHandles")?.iter().map(|value| value.as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| invalid("invalid operation handle"))).collect::<EncodingResult<Vec<_>>>()?;
        instance.barrier.release(id, &handles).map_err(|message| host_error(&message))?;
        Ok(json!({"barrierId":id,"operationHandles":handles}))
    },
    "kernel.clock.set" => set_clock,
    "kernel.fault.arm" => arm_fault,
];

type ProcessBinding = fn(&Syscalls) -> Value;
const PROCESS_CONTROLS: &[(&str, ProcessBinding)] = routing![
    "kernel.mutant.activation" => |syscalls| {
        let count = syscalls.mutant.as_ref().map_or(0, KernelMutant::activation_count);
        json!({"activation":{
            "mutantId":syscalls.mutant.as_ref().map(|mutant| mutant.kind().id()),
            "signal":syscalls.mutant.as_ref().map(|mutant| mutant.kind().signal()),
            "activated": count > 0,
            "activationCount":count
        }})
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_native_entry_is_a_protocol_error_on_every_await() {
        let syscalls = Arc::new(Syscalls::default());
        let handle = json!(syscalls.create().unwrap());
        let instance = syscalls.instance(&handle).unwrap();
        for domain in [ClockDomain::Backend, ClockDomain::Worker] {
            instance.controls.set_clock(domain, 0).unwrap();
        }
        let lock = instance.kernel.lock().unwrap();
        let started = syscalls
            .start(BINDINGS[0].0.to_owned(), json!({}), handle)
            .unwrap();
        let operation = started["operationHandle"].as_str().unwrap();
        syscalls.cancel(operation, "before entry").unwrap();
        drop(lock);
        for _ in 0..2 {
            let error = syscalls.await_operation(operation, None).err().unwrap();
            assert_eq!(error.code, "operation_cancelled_before_entry");
            assert_eq!(error.message, "before entry");
        }
    }
}
