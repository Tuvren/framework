use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use tuvren_kernel_rust::*;

use crate::observation_encoding::{
    self as encoding, EncodingResult, decode_record, encode_record, invalid,
};

pub(crate) trait Observation {
    fn encode(&self) -> EncodingResult<Value>;
}
impl Observation for String {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(json!(self))
    }
}
impl Observation for bool {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(json!(self))
    }
}
impl Observation for i64 {
    fn encode(&self) -> EncodingResult<Value> {
        encoding::integer(*self)
    }
}
impl Observation for usize {
    fn encode(&self) -> EncodingResult<Value> {
        encoding::integer(i64::try_from(*self).map_err(|_| invalid("integer out of range"))?)
    }
}
impl<T: Observation> Observation for Vec<T> {
    fn encode(&self) -> EncodingResult<Value> {
        self.iter()
            .map(Observation::encode)
            .collect::<EncodingResult<Vec<_>>>()
            .map(Value::Array)
    }
}
impl<T: Observation> Observation for Option<T> {
    fn encode(&self) -> EncodingResult<Value> {
        self.as_ref()
            .map(Observation::encode)
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
}
impl Observation for KernelRecord {
    fn encode(&self) -> EncodingResult<Value> {
        encode_record(self)
    }
}
impl Observation for PathValue {
    fn encode(&self) -> EncodingResult<Value> {
        match self {
            Self::Null => Ok(Value::Null),
            Self::Single(v) => v.encode(),
            Self::Ordered(v) => v.encode(),
        }
    }
}
impl Observation for TurnTreeManifest {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(
            json!({"$map":self.iter().map(|(k,v)| Ok(json!([k,v.encode()?]))).collect::<EncodingResult<Vec<_>>>()?}),
        )
    }
}
macro_rules! fields {
    ($value:expr, $( $name:literal => $field:ident ),* $(,)?) => {{
        let mut object = Map::new();
        $(object.insert($name.into(),$value.$field.encode()?);)*
        object
    }};
}
macro_rules! optional {
    ($object:expr,$value:expr,$( $name:literal => $field:ident ),* $(,)?) => {
        $(if let Some(v) = &$value.$field { $object.insert($name.into(),v.encode()?); })*
    };
}
macro_rules! record {
    ($type:ty, $( $name:literal => $field:ident ),* $(,)?) => {
        impl Observation for $type { fn encode(&self) -> EncodingResult<Value> { Ok(Value::Object(fields!(self,$($name => $field),*))) } }
    };
}
record!(ThreadCreateResult,"threadId"=>thread_id,"branchId"=>branch_id,"rootTurnTreeHash"=>root_turn_tree_hash,"rootTurnNodeHash"=>root_turn_node_hash);
record!(ThreadRecord,"threadId"=>thread_id,"schemaId"=>schema_id,"rootTurnNodeHash"=>root_turn_node_hash);
record!(StoredThreadEntry,"threadId"=>thread_id,"schemaId"=>schema_id,"rootTurnNodeHash"=>root_turn_node_hash,"createdAtMs"=>created_at_ms);
record!(IncorporationRule,"objectType"=>object_type,"targetPath"=>target_path);
record!(TurnTreeSchema,"schemaId"=>schema_id,"paths"=>paths,"incorporationRules"=>incorporation_rules);
record!(RecoveryState,"lastTurnNodeHash"=>last_turn_node_hash,"lastCompletedStepId"=>last_completed_step_id,"stepSequence"=>step_sequence,"consumedStagedResults"=>consumed_staged_results,"uncommittedStagedResults"=>uncommitted_staged_results);
record!(StepContext,"step"=>step,"schema"=>schema,"currentTurnNodeHash"=>current_turn_node_hash,"signals"=>signals);
record!(TurnNode,"hash"=>hash,"schemaId"=>schema_id,"turnTreeHash"=>turn_tree_hash,"previousTurnNodeHash"=>previous_turn_node_hash,"eventHash"=>event_hash,"consumedStagedResults"=>consumed_staged_results);
impl Observation for PathCollectionKind {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(json!(match self {
            Self::Ordered => "ordered",
            Self::Single => "single",
        }))
    }
}
impl Observation for PathDefinition {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o = fields!(self,"path"=>path,"collection"=>collection);
        optional!(o,self,"metadata"=>metadata);
        Ok(Value::Object(o))
    }
}
impl Observation for StepDeclaration {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o =
            fields!(self,"id"=>id,"deterministic"=>deterministic,"sideEffects"=>side_effects);
        optional!(o,self,"metadata"=>metadata);
        Ok(Value::Object(o))
    }
}
impl Observation for BranchRecord {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o = fields!(self,"branchId"=>branch_id,"threadId"=>thread_id,"headTurnNodeHash"=>head_turn_node_hash);
        optional!(o,self,"archivedFromBranchId"=>archived_from_branch_id);
        Ok(Value::Object(o))
    }
}
impl Observation for SetHeadResult {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o = fields!(self,"branch"=>branch);
        optional!(o,self,"archiveBranch"=>archive_branch);
        Ok(Value::Object(o))
    }
}
impl Observation for TurnRecord {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o = fields!(self,"turnId"=>turn_id,"threadId"=>thread_id,"branchId"=>branch_id,"startTurnNodeHash"=>start_turn_node_hash,"headTurnNodeHash"=>head_turn_node_hash);
        optional!(o,self,"parentTurnId"=>parent_turn_id);
        Ok(Value::Object(o))
    }
}
impl Observation for RunStatus {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(json!(match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Paused => "paused",
        }))
    }
}
impl Observation for RunRecord {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o = fields!(self,"runId"=>run_id,"turnId"=>turn_id,"branchId"=>branch_id,"schemaId"=>schema_id,"startTurnNodeHash"=>start_turn_node_hash,"stepSequence"=>step_sequence,"currentStepIndex"=>current_step_index,"status"=>status,"createdTurnNodes"=>created_turn_nodes);
        optional!(o,self,"executionOwnerId"=>execution_owner_id,"fencingToken"=>fencing_token,"leaseExpiresAtMs"=>lease_expires_at_ms,"preemptionReason"=>preemption_reason);
        Ok(Value::Object(o))
    }
}
impl Observation for StagedResultStatus {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(json!(match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }))
    }
}
impl Observation for StagedResult {
    fn encode(&self) -> EncodingResult<Value> {
        let mut o = fields!(self,"taskId"=>task_id,"objectHash"=>object_hash,"objectType"=>object_type,"status"=>status,"timestamp"=>timestamp_ms);
        optional!(o,self,"interruptPayload"=>interrupt_payload);
        Ok(Value::Object(o))
    }
}
impl Observation for Verdict {
    fn encode(&self) -> EncodingResult<Value> {
        Ok(match self {
            Self::Proceed => json!({"kind":"proceed"}),
            Self::Modify { transform } => json!({"kind":"modify","transform":transform.encode()?}),
            Self::Retry { adjustment } => json!({"kind":"retry","adjustment":adjustment.encode()?}),
            Self::Pause {
                reason,
                resumption_schema,
            } => {
                json!({"kind":"pause","reason":reason,"resumptionSchema":resumption_schema.encode()?})
            }
            Self::Abort {
                disposition,
                reason,
            } => {
                json!({"kind":"abort","reason":reason,"disposition":match disposition { VerdictDisposition::HardFail=>"HardFail",VerdictDisposition::SoftFail=>"SoftFail",VerdictDisposition::EndTurn=>"EndTurn"}})
            }
        })
    }
}

pub(crate) fn field<'a>(v: &'a Value, key: &str) -> EncodingResult<&'a Value> {
    v.get(key)
        .ok_or_else(|| invalid(&format!("missing syscall argument {key}")))
}
pub(crate) fn text<'a>(v: &'a Value, key: &str) -> EncodingResult<&'a str> {
    field(v, key)?
        .as_str()
        .ok_or_else(|| invalid(&format!("expected text argument {key}")))
}
pub(crate) fn optional_text(v: &Value, key: &str) -> EncodingResult<Option<String>> {
    v.get(key)
        .map(|_| text(v, key).map(str::to_owned))
        .transpose()
}
pub(crate) fn list<'a>(v: &'a Value, key: &str) -> EncodingResult<&'a [Value]> {
    field(v, key)?
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid("expected array"))
}
fn boolean(v: &Value, key: &str) -> EncodingResult<bool> {
    field(v, key)?
        .as_bool()
        .ok_or_else(|| invalid("expected boolean"))
}
pub(crate) fn number(v: &Value, key: &str) -> EncodingResult<i64> {
    let n = field(v, key)?
        .as_i64()
        .ok_or_else(|| invalid("expected integer"))?;
    encoding::integer(n)?;
    Ok(n)
}
pub(crate) fn optional_record(v: &Value, key: &str) -> EncodingResult<Option<KernelRecord>> {
    v.get(key).map(decode_record).transpose()
}
pub(crate) fn schema(v: &Value) -> EncodingResult<TurnTreeSchema> {
    Ok(TurnTreeSchema {
        schema_id: text(v, "schemaId")?.into(),
        paths: list(v, "paths")?
            .iter()
            .map(|v| {
                Ok(PathDefinition {
                    path: text(v, "path")?.into(),
                    collection: match text(v, "collection")? {
                        "ordered" => PathCollectionKind::Ordered,
                        "single" => PathCollectionKind::Single,
                        _ => return Err(invalid("invalid collection")),
                    },
                    metadata: optional_record(v, "metadata")?,
                })
            })
            .collect::<EncodingResult<_>>()?,
        incorporation_rules: list(v, "incorporationRules")?
            .iter()
            .map(|v| {
                Ok(IncorporationRule {
                    object_type: text(v, "objectType")?.into(),
                    target_path: text(v, "targetPath")?.into(),
                })
            })
            .collect::<EncodingResult<_>>()?,
    })
}
pub(crate) fn step(v: &Value) -> EncodingResult<StepDeclaration> {
    Ok(StepDeclaration {
        id: text(v, "id")?.into(),
        deterministic: boolean(v, "deterministic")?,
        side_effects: boolean(v, "sideEffects")?,
        metadata: optional_record(v, "metadata")?,
    })
}
pub(crate) fn status(v: &str) -> EncodingResult<StagedResultStatus> {
    match v {
        "completed" => Ok(StagedResultStatus::Completed),
        "failed" => Ok(StagedResultStatus::Failed),
        "interrupted" => Ok(StagedResultStatus::Interrupted),
        _ => Err(invalid("invalid staged result status")),
    }
}
pub(crate) fn staged(v: &Value) -> EncodingResult<StagedResult> {
    Ok(StagedResult {
        object_hash: text(v, "objectHash")?.into(),
        object_type: text(v, "objectType")?.into(),
        task_id: text(v, "taskId")?.into(),
        timestamp_ms: number(v, "timestamp")?,
        status: status(text(v, "status")?)?,
        interrupt_payload: optional_record(v, "interruptPayload")?,
    })
}
pub(crate) fn verdict(v: &Value) -> EncodingResult<Verdict> {
    Ok(match text(v, "kind")? {
        "proceed" => Verdict::Proceed,
        "modify" => Verdict::Modify {
            transform: decode_record(field(v, "transform")?)?,
        },
        "retry" => Verdict::Retry {
            adjustment: decode_record(field(v, "adjustment")?)?,
        },
        "pause" => Verdict::Pause {
            reason: text(v, "reason")?.into(),
            resumption_schema: decode_record(field(v, "resumptionSchema")?)?,
        },
        "abort" => Verdict::Abort {
            reason: text(v, "reason")?.into(),
            disposition: match text(v, "disposition")? {
                "HardFail" => VerdictDisposition::HardFail,
                "SoftFail" => VerdictDisposition::SoftFail,
                "EndTurn" => VerdictDisposition::EndTurn,
                _ => return Err(invalid("invalid disposition")),
            },
        },
        _ => return Err(invalid("invalid verdict kind")),
    })
}
pub(crate) fn changes(v: &Value) -> EncodingResult<TurnTreeManifest> {
    let KernelRecord::Map(entries) = decode_record(v)? else {
        return Err(invalid("expected changes record"));
    };
    entries
        .into_iter()
        .map(|(k, v)| {
            Ok((
                k,
                match v {
                    KernelRecord::Null => PathValue::Null,
                    KernelRecord::Text(v) => PathValue::Single(v),
                    KernelRecord::Array(v) => PathValue::Ordered(
                        v.into_iter()
                            .map(|v| match v {
                                KernelRecord::Text(v) => Ok(v),
                                _ => Err(invalid("expected hash")),
                            })
                            .collect::<EncodingResult<_>>()?,
                    ),
                    _ => return Err(invalid("invalid path value")),
                },
            ))
        })
        .collect::<EncodingResult<BTreeMap<_, _>>>()
}

pub(crate) fn annotation(value: &Value) -> EncodingResult<Vec<u8>> {
    let record = decode_record(value)?;
    if !matches!(record, KernelRecord::Map(_)) {
        return Err(invalid("annotations must be kernel objects"));
    }
    encode_deterministic_kernel_record(&record).map_err(|error| invalid(&error.payload.message))
}
