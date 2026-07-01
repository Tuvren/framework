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

use std::collections::BTreeMap;

pub type HashString = String;
pub type EpochMs = i64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KernelRecord {
    Null,
    Bool(bool),
    Integer(i64),
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<KernelRecord>),
    Map(BTreeMap<String, KernelRecord>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PathCollectionKind {
    Ordered,
    Single,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PathValue {
    Ordered(Vec<HashString>),
    Single(HashString),
    Null,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathDefinition {
    pub collection: PathCollectionKind,
    pub metadata: Option<KernelRecord>,
    pub path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IncorporationRule {
    pub object_type: String,
    pub target_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnTreeSchema {
    pub incorporation_rules: Vec<IncorporationRule>,
    pub paths: Vec<PathDefinition>,
    pub schema_id: String,
}

pub type TurnTreeManifest = BTreeMap<String, PathValue>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepDeclaration {
    pub deterministic: bool,
    pub id: String,
    pub metadata: Option<KernelRecord>,
    pub side_effects: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerdictDisposition {
    HardFail,
    SoftFail,
    EndTurn,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Verdict {
    Proceed,
    Abort {
        disposition: VerdictDisposition,
        reason: String,
    },
    Modify {
        transform: KernelRecord,
    },
    Pause {
        reason: String,
        resumption_schema: KernelRecord,
    },
    Retry {
        adjustment: KernelRecord,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StagedResultStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedResult {
    pub interrupt_payload: Option<KernelRecord>,
    pub object_hash: HashString,
    pub object_type: String,
    pub status: StagedResultStatus,
    pub task_id: String,
    pub timestamp_ms: EpochMs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObserveResult {
    pub annotations: Vec<Vec<u8>>,
    pub signals: Vec<KernelRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnNode {
    pub consumed_staged_results: Vec<StagedResult>,
    pub event_hash: Option<HashString>,
    pub hash: HashString,
    pub previous_turn_node_hash: Option<HashString>,
    pub schema_id: String,
    pub turn_tree_hash: HashString,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadRecord {
    pub root_turn_node_hash: HashString,
    pub schema_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BranchRecord {
    pub branch_id: String,
    pub head_turn_node_hash: HashString,
    pub thread_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnRecord {
    pub branch_id: String,
    pub head_turn_node_hash: HashString,
    pub parent_turn_id: Option<String>,
    pub start_turn_node_hash: HashString,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunStatus {
    Running,
    Paused,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunCompletionStatus {
    Paused,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunRecord {
    pub branch_id: String,
    pub created_turn_nodes: Vec<HashString>,
    pub current_step_index: usize,
    pub run_id: String,
    pub schema_id: String,
    pub start_turn_node_hash: HashString,
    pub status: RunStatus,
    pub step_sequence: Vec<StepDeclaration>,
    pub turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepContext {
    pub current_turn_node_hash: HashString,
    pub schema: TurnTreeSchema,
    pub signals: Vec<KernelRecord>,
    pub step: StepDeclaration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryState {
    pub consumed_staged_results: Vec<StagedResult>,
    pub last_completed_step_id: Option<String>,
    pub last_turn_node_hash: HashString,
    pub step_sequence: Vec<StepDeclaration>,
    pub uncommitted_staged_results: Vec<StagedResult>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadCreateResult {
    pub branch_id: String,
    pub root_turn_node_hash: HashString,
    pub root_turn_tree_hash: HashString,
    pub thread_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetHeadResult {
    pub archive_branch: Option<BranchRecord>,
    pub branch: BranchRecord,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KernelErrorPayload {
    pub code: String,
    pub details: Option<KernelRecord>,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{payload_message}")]
pub struct KernelError {
    payload_message: String,
    pub payload: KernelErrorPayload,
}

impl KernelError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<KernelRecord>,
    ) -> Self {
        let message = message.into();
        Self {
            payload_message: message.clone(),
            payload: KernelErrorPayload {
                code: code.into(),
                details,
                message,
            },
        }
    }
}

pub type KernelResult<T> = Result<T, KernelError>;
