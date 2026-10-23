use std::collections::BTreeMap;

use serde_json::{Value, json};
use tuvren_kernel_rust::{
    InMemoryKernel, KernelError, LeasedRunCreateInput, ObserveResult, RunCompletionStatus,
    ThreadListOptions,
};

use tuvren_kernel_rust::testkit::mutants::KernelMutant;
use tuvren_kernel_rust::testkit::{ClockDomain, FaultRequest, KernelTestControls};

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

struct Instance {
    kernel: Option<InMemoryKernel>,
    controls: KernelTestControls,
}
#[derive(Default)]
pub(crate) struct Syscalls {
    instances: BTreeMap<String, Instance>,
    next_handle: u64,
    mutant: Option<KernelMutant>,
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

    pub(crate) fn create(&mut self) -> String {
        self.next_handle += 1;
        let handle = format!("rust-kernel-{}", self.next_handle);
        self.instances.insert(
            handle.clone(),
            Instance {
                kernel: None,
                controls: KernelTestControls::with_mutant(self.mutant.clone()),
            },
        );
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
            || PROCESS_CONTROLS.iter().any(|(name, _)| *name == operation)
    }
    pub(crate) fn dispatch(
        &mut self,
        operation: &str,
        input: &Value,
        handle: &Value,
    ) -> Result<OperationOutcome, AdapterErrorEnvelope> {
        if let Some((_, binding)) = PROCESS_CONTROLS.iter().find(|(name, _)| *name == operation) {
            return Ok(OperationOutcome::Result {
                value: json!({"result":binding(self)}),
            });
        }
        let instance = handle
            .as_str()
            .and_then(|h| self.instances.get_mut(h))
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
            if instance.kernel.is_none() {
                instance.kernel = Some(
                    InMemoryKernel::with_test_controls(instance.controls.clone()).map_err(
                        |error| adapter_error(&error.payload.code, &error.payload.message, None),
                    )?,
                );
            }
            let kernel = instance
                .kernel
                .as_ref()
                .ok_or_else(|| invalid("kernel initialization failed"))?;
            binding(kernel, input)
        } else if let Some((_, binding)) = CONTROLS.iter().find(|(name, _)| *name == operation) {
            binding(instance, input)
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
                        .map(encoding::encode_error_details)
                        .transpose()?,
                },
            }),
        }
    }
}

type ControlBinding = fn(&Instance, &Value) -> CallResult;
const CONTROLS: &[(&str, ControlBinding)] = routing![
    "kernel.clock.set" => |instance, a| {
        let domain: ClockDomain = serde_json::from_value(field(a, "domain")?.clone())
            .map_err(|_| invalid("invalid clock domain"))?;
        instance.controls.set_clock(domain, number(a, "nowMs")?)
            .map_err(|error| adapter_error(&error.payload.code, &error.payload.message, None))?;
        Ok(json!({}))
    },
    "kernel.fault.arm" => |instance, a| {
        let mut request = a.as_object().cloned().ok_or_else(|| invalid("expected fault request"))?;
        request.remove("instance");
        let request: FaultRequest = serde_json::from_value(Value::Object(request))
            .map_err(|_| invalid("invalid fault request"))?;
        if request.occurrence == 0 || request.occurrence > 9_007_199_254_740_991 {
            return Err(invalid("fault occurrence requires a positive safe integer").into());
        }
        Ok(json!({"token":instance.controls.arm_fault(request)?}))
    },
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
