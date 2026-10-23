use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use serde_json::{Value, json};
use tuvren_kernel_rust::{
    InMemoryKernel, InMemoryKernelOptions, KernelError, ObserveResult, RunCompletionStatus,
    ThreadListOptions,
};

use crate::observation_encoding::{self as encoding, EncodingResult, invalid};
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
            optional_text(a, "parentTurnId")?,
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

struct Instance {
    kernel: InMemoryKernel,
    clock: Arc<AtomicI64>,
}
#[derive(Default)]
pub(crate) struct Syscalls {
    instances: BTreeMap<String, Instance>,
    next_handle: u64,
}
impl Syscalls {
    pub(crate) fn create(&mut self) -> String {
        self.next_handle += 1;
        let handle = format!("rust-kernel-{}", self.next_handle);
        let clock = Arc::new(AtomicI64::new(0));
        let now = Arc::clone(&clock);
        let kernel = InMemoryKernel::with_options(InMemoryKernelOptions {
            now: Some(Arc::new(move || now.load(Ordering::SeqCst))),
        });
        self.instances
            .insert(handle.clone(), Instance { kernel, clock });
        handle
    }
    pub(crate) fn destroy(&mut self, handle: &Value) {
        if let Some(handle) = handle.as_str() {
            self.instances.remove(handle);
        }
    }
    pub(crate) fn has(operation: &str) -> bool {
        BINDINGS.iter().any(|(name, _)| *name == operation)
            || CONTROLS.iter().any(|(name, _)| *name == operation)
    }
    pub(crate) fn dispatch(
        &self,
        operation: &str,
        input: &Value,
        handle: &Value,
    ) -> Result<OperationOutcome, AdapterErrorEnvelope> {
        let instance = handle
            .as_str()
            .and_then(|h| self.instances.get(h))
            .ok_or_else(|| {
                adapter_error(
                    "adapter_invalid_instance",
                    "syscall requires a live adapter instance",
                    None,
                )
            })?;
        let result = if let Some((_, binding)) =
            BINDINGS.iter().find(|(name, _)| *name == operation)
        {
            binding(&instance.kernel, input)
        } else if let Some((_, binding)) = CONTROLS.iter().find(|(name, _)| *name == operation) {
            binding(instance, input).map_err(BridgeError::Adapter)
        } else {
            return Err(adapter_error(
                "adapter_operation_not_implemented",
                "unsupported syscall",
                None,
            ));
        };
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
                        .map(encoding::encode_record)
                        .transpose()?,
                },
            }),
        }
    }
}

type ControlBinding = fn(&Instance, &Value) -> EncodingResult<Value>;
const CONTROLS: &[(&str, ControlBinding)] = routing![
    "kernel.clock.set" => |instance, a| match text(a, "domain")? {
        "worker" => {
            instance.clock.store(number(a, "nowMs")?, Ordering::SeqCst);
            Ok(json!({}))
        }
        "backend" => Err(adapter_error(
            "adapter_clock_unsupported",
            "Rust kernel has no separate public backend clock seam",
            None,
        )),
        _ => Err(invalid("invalid clock domain")),
    },
    "kernel.fault.arm" => |_, _| {
        Err(adapter_error(
            "adapter_fault_unsupported",
            "Rust kernel has no public fault arming seam",
            None,
        ))
    },
];
