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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::cbor::encode_deterministic_kernel_record;
use crate::identity::{hash_bytes_to_hex, hash_turn_node_identity, hash_turn_tree_identity};
use crate::types::{
    BranchRecord, EpochMs, HashString, IncorporationRule, KernelError, KernelRecord, KernelResult,
    ObserveResult, PathCollectionKind, PathValue, RecoveryState, RunCompletionStatus, RunRecord,
    RunStatus, SetHeadResult, StagedResult, StagedResultStatus, StepContext, StepDeclaration,
    ThreadCreateResult, ThreadRecord, TurnNode, TurnRecord, TurnTreeManifest, TurnTreeSchema,
    Verdict,
};

const MIN_SAFE_EPOCH_MS: EpochMs = -9_007_199_254_740_991;
const MAX_SAFE_EPOCH_MS: EpochMs = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct InMemoryKernel {
    // Epic U deliberately keeps the Rust baseline process-local. Durable
    // storage and TS runtime switching are Epic V+ concerns.
    state: Arc<Mutex<KernelState>>,
    now: Arc<dyn Fn() -> EpochMs + Send + Sync>,
}

pub struct InMemoryKernelOptions {
    pub now: Option<Arc<dyn Fn() -> EpochMs + Send + Sync>>,
}

#[derive(Clone, Debug)]
struct ObjectRecord {
    blob: Vec<u8>,
}

#[derive(Clone, Debug)]
struct StoredTurnTree {
    manifest: TurnTreeManifest,
    schema_id: String,
}

/// ADR-034: capability descriptor returned by InMemoryKernel::capabilities().
#[derive(Clone, Debug)]
pub struct BackendCapability {
    pub thread_enumeration: bool,
}

/// ADR-034: options for thread_list.
#[derive(Clone, Debug, Default)]
pub struct ThreadListOptions {
    pub limit: Option<usize>,
    /// Opaque cursor: (last_created_at_ms, last_thread_id).
    pub cursor: Option<(EpochMs, String)>,
    pub filter_schema_id: Option<String>,
}

pub type ThreadListResult = KernelResult<(Vec<StoredThreadEntry>, Option<(EpochMs, String)>)>;

/// ADR-034: a stored thread record with creation timestamp for enumeration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredThreadEntry {
    pub thread_id: String,
    pub schema_id: String,
    pub root_turn_node_hash: HashString,
    pub created_at_ms: EpochMs,
}

#[derive(Default)]
struct KernelState {
    archive_counter: u64,
    branches: HashMap<String, BranchRecord>,
    objects: HashMap<HashString, ObjectRecord>,
    runs: HashMap<String, RunRecord>,
    run_signals: HashMap<String, Vec<KernelRecord>>,
    schemas: HashMap<String, TurnTreeSchema>,
    staged_results: HashMap<String, Vec<StagedResult>>,
    threads: HashMap<String, ThreadRecord>,
    thread_created_at: HashMap<String, EpochMs>,
    turn_nodes: HashMap<HashString, TurnNode>,
    turn_order: Vec<String>,
    turns: HashMap<String, TurnRecord>,
    turn_trees: HashMap<HashString, StoredTurnTree>,
}

impl Default for InMemoryKernel {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryKernel {
    pub fn new() -> Self {
        Self::with_options(InMemoryKernelOptions { now: None })
    }

    pub fn with_options(options: InMemoryKernelOptions) -> Self {
        Self {
            state: Arc::new(Mutex::new(KernelState::default())),
            now: options.now.unwrap_or_else(|| Arc::new(default_now_ms)),
        }
    }

    pub fn store_put(
        &self,
        blob: Vec<u8>,
        _media_type: Option<String>,
    ) -> KernelResult<HashString> {
        let object_hash = hash_bytes_to_hex(&blob);
        let mut state = self.lock_state()?;
        state
            .objects
            .insert(object_hash.clone(), ObjectRecord { blob });
        Ok(object_hash)
    }

    pub fn store_get(&self, hash: &str) -> KernelResult<Option<Vec<u8>>> {
        let state = self.lock_state()?;
        Ok(state.objects.get(hash).map(|record| record.blob.clone()))
    }

    pub fn store_has(&self, hash: &str) -> KernelResult<bool> {
        let state = self.lock_state()?;
        Ok(state.objects.contains_key(hash))
    }

    pub fn schema_register(&self, schema: TurnTreeSchema) -> KernelResult<String> {
        validate_schema(&schema)?;
        let schema_id = schema.schema_id.clone();
        let mut state = self.lock_state()?;
        if state.schemas.contains_key(&schema_id) {
            return Err(duplicate("schema_already_exists", "schema already exists"));
        }
        state.schemas.insert(schema_id.clone(), schema);
        Ok(schema_id)
    }

    pub fn schema_get(&self, schema_id: &str) -> KernelResult<Option<TurnTreeSchema>> {
        let state = self.lock_state()?;
        Ok(state.schemas.get(schema_id).cloned())
    }

    pub fn tree_create(
        &self,
        schema_id: &str,
        changes: TurnTreeManifest,
        base_turn_tree_hash: Option<&str>,
    ) -> KernelResult<HashString> {
        let mut state = self.lock_state()?;
        let schema = state
            .schemas
            .get(schema_id)
            .cloned()
            .ok_or_else(|| missing("schema_not_found", "schema does not exist"))?;
        let mut manifest = match base_turn_tree_hash {
            Some(hash) => {
                let base_tree = state.turn_trees.get(hash).ok_or_else(|| {
                    missing("turn_tree_not_found", "base turn tree does not exist")
                })?;
                if base_tree.schema_id != schema_id {
                    return Err(KernelError::new(
                        "turn_tree_schema_mismatch",
                        "base turn tree schema must match requested schema",
                        None,
                    ));
                }
                base_tree.manifest.clone()
            }
            None => {
                // Without a base tree there is no previous manifest to fill
                // gaps, so callers must provide the complete schema surface.
                ensure_complete_tree_create_changes(&schema, &changes)?;
                empty_manifest(&schema)
            }
        };

        apply_changes(&schema, &mut manifest, changes)?;
        let tree_hash = hash_turn_tree_identity(schema_id, &manifest)?;
        state.turn_trees.insert(
            tree_hash.clone(),
            StoredTurnTree {
                manifest,
                schema_id: schema_id.to_string(),
            },
        );
        Ok(tree_hash)
    }

    pub fn tree_incorporate(
        &self,
        base_turn_tree_hash: &str,
        staged_results: &[StagedResult],
    ) -> KernelResult<HashString> {
        let mut state = self.lock_state()?;
        let base_tree = state
            .turn_trees
            .get(base_turn_tree_hash)
            .cloned()
            .ok_or_else(|| missing("turn_tree_not_found", "base turn tree does not exist"))?;
        let schema = state
            .schemas
            .get(&base_tree.schema_id)
            .cloned()
            .ok_or_else(|| missing("schema_not_found", "turn tree schema does not exist"))?;
        let mut manifest = base_tree.manifest;

        for staged_result in staged_results {
            validate_staged_result_durable(&state, staged_result)?;
            let rule = schema
                .incorporation_rules
                .iter()
                .find(|rule| rule.object_type == staged_result.object_type)
                .ok_or_else(|| {
                    KernelError::new(
                        "incorporation_rule_not_found",
                        "staged result object type has no incorporation rule",
                        None,
                    )
                })?;
            apply_incorporation_rule(&schema, &mut manifest, rule, staged_result)?;
        }

        let tree_hash = hash_turn_tree_identity(&schema.schema_id, &manifest)?;
        state.turn_trees.insert(
            tree_hash.clone(),
            StoredTurnTree {
                manifest,
                schema_id: schema.schema_id,
            },
        );
        Ok(tree_hash)
    }

    pub fn tree_diff(&self, tree_hash_a: &str, tree_hash_b: &str) -> KernelResult<Vec<String>> {
        let state = self.lock_state()?;
        let tree_a = state
            .turn_trees
            .get(tree_hash_a)
            .ok_or_else(|| missing("turn_tree_not_found", "left turn tree does not exist"))?;
        let tree_b = state
            .turn_trees
            .get(tree_hash_b)
            .ok_or_else(|| missing("turn_tree_not_found", "right turn tree does not exist"))?;
        if tree_a.schema_id != tree_b.schema_id {
            return Err(KernelError::new(
                "turn_tree_schema_mismatch",
                "turn trees with different schemas cannot be diffed",
                None,
            ));
        }

        Ok(tree_a
            .manifest
            .iter()
            .filter(|(path, value)| tree_b.manifest.get(*path) != Some(*value))
            .map(|(path, _)| path.clone())
            .collect())
    }

    pub fn tree_resolve(&self, tree_hash: &str, path: &str) -> KernelResult<PathValue> {
        let state = self.lock_state()?;
        let tree = state
            .turn_trees
            .get(tree_hash)
            .ok_or_else(|| missing("turn_tree_not_found", "turn tree does not exist"))?;
        tree.manifest
            .get(path)
            .cloned()
            .ok_or_else(|| missing("turn_tree_path_not_found", "turn tree path does not exist"))
    }

    pub fn tree_manifest(&self, tree_hash: &str) -> KernelResult<TurnTreeManifest> {
        let state = self.lock_state()?;
        Ok(state
            .turn_trees
            .get(tree_hash)
            .ok_or_else(|| missing("turn_tree_not_found", "turn tree does not exist"))?
            .manifest
            .clone())
    }

    pub fn node_get(&self, hash: &str) -> KernelResult<Option<TurnNode>> {
        let state = self.lock_state()?;
        Ok(state.turn_nodes.get(hash).cloned())
    }

    pub fn node_walk_back(&self, from_hash: &str) -> KernelResult<Vec<TurnNode>> {
        let state = self.lock_state()?;
        let mut nodes = Vec::new();
        let mut next_hash = Some(from_hash.to_string());

        while let Some(hash) = next_hash {
            let node = state
                .turn_nodes
                .get(&hash)
                .cloned()
                .ok_or_else(|| missing("turn_node_not_found", "turn node does not exist"))?;
            next_hash = node.previous_turn_node_hash.clone();
            nodes.push(node);
        }

        Ok(nodes)
    }

    pub fn thread_create(
        &self,
        thread_id: &str,
        schema_id: &str,
        initial_branch_id: &str,
    ) -> KernelResult<ThreadCreateResult> {
        validate_id(
            thread_id,
            "invalid_thread_id",
            "thread id must not be empty",
        )?;
        validate_id(
            initial_branch_id,
            "invalid_branch_id",
            "initial branch id must not be empty",
        )?;
        let mut state = self.lock_state()?;
        if state.threads.contains_key(thread_id) {
            return Err(duplicate("thread_already_exists", "thread already exists"));
        }
        if state.branches.contains_key(initial_branch_id) {
            return Err(duplicate("branch_already_exists", "branch already exists"));
        }
        let schema = state
            .schemas
            .get(schema_id)
            .cloned()
            .ok_or_else(|| missing("schema_not_found", "schema does not exist"))?;
        let manifest = empty_manifest(&schema);
        let root_turn_tree_hash = hash_turn_tree_identity(schema_id, &manifest)?;
        state.turn_trees.insert(
            root_turn_tree_hash.clone(),
            StoredTurnTree {
                manifest,
                schema_id: schema_id.to_string(),
            },
        );
        let root_event_blob = format!("tuvren.kernel.thread-root:{thread_id}").into_bytes();
        let root_event_hash = hash_bytes_to_hex(&root_event_blob);
        state.objects.insert(
            root_event_hash.clone(),
            ObjectRecord {
                blob: root_event_blob,
            },
        );
        let mut root_node = TurnNode {
            consumed_staged_results: Vec::new(),
            // Root nodes include a backend-owned event object so two threads
            // sharing a schema do not collapse to the same genesis hash.
            event_hash: Some(root_event_hash),
            hash: String::new(),
            previous_turn_node_hash: None,
            schema_id: schema_id.to_string(),
            turn_tree_hash: root_turn_tree_hash.clone(),
        };
        root_node.hash = hash_turn_node_identity(&root_node)?;
        state
            .turn_nodes
            .insert(root_node.hash.clone(), root_node.clone());
        let created_at_ms = (self.now)();
        state.threads.insert(
            thread_id.to_string(),
            ThreadRecord {
                root_turn_node_hash: root_node.hash.clone(),
                schema_id: schema_id.to_string(),
                thread_id: thread_id.to_string(),
            },
        );
        state
            .thread_created_at
            .insert(thread_id.to_string(), created_at_ms);
        state.branches.insert(
            initial_branch_id.to_string(),
            BranchRecord {
                branch_id: initial_branch_id.to_string(),
                head_turn_node_hash: root_node.hash.clone(),
                thread_id: thread_id.to_string(),
            },
        );
        Ok(ThreadCreateResult {
            branch_id: initial_branch_id.to_string(),
            root_turn_node_hash: root_node.hash,
            root_turn_tree_hash,
            thread_id: thread_id.to_string(),
        })
    }

    /// ADR-034: returns the capability descriptor for this backend.
    pub fn capabilities(&self) -> BackendCapability {
        BackendCapability {
            thread_enumeration: true,
        }
    }

    /// ADR-034: list threads sorted by (created_at_ms ASC, thread_id ASC).
    /// Supports cursor-based pagination and optional schemaId filter.
    pub fn thread_list(&self, options: ThreadListOptions) -> ThreadListResult {
        let state = self.lock_state()?;
        let mut entries: Vec<StoredThreadEntry> = state
            .threads
            .values()
            .filter_map(|t| {
                let created_at_ms = *state.thread_created_at.get(&t.thread_id)?;
                if options
                    .filter_schema_id
                    .as_ref()
                    .is_some_and(|id| id != &t.schema_id)
                {
                    return None;
                }
                Some(StoredThreadEntry {
                    thread_id: t.thread_id.clone(),
                    schema_id: t.schema_id.clone(),
                    root_turn_node_hash: t.root_turn_node_hash.clone(),
                    created_at_ms,
                })
            })
            .collect();

        entries.sort_by(|a, b| {
            a.created_at_ms
                .cmp(&b.created_at_ms)
                .then_with(|| a.thread_id.cmp(&b.thread_id))
        });

        if let Some((last_created_at_ms, ref last_thread_id)) = options.cursor {
            entries.retain(|e| {
                e.created_at_ms > last_created_at_ms
                    || (e.created_at_ms == last_created_at_ms
                        && e.thread_id.as_str() > last_thread_id.as_str())
            });
        }

        let next_cursor = if let Some(limit) = options.limit {
            if entries.len() > limit {
                entries.truncate(limit);
                let last = entries.last().unwrap();
                Some((last.created_at_ms, last.thread_id.clone()))
            } else {
                None
            }
        } else {
            None
        };

        Ok((entries, next_cursor))
    }

    pub fn thread_get(&self, thread_id: &str) -> KernelResult<Option<ThreadRecord>> {
        validate_id(
            thread_id,
            "invalid_thread_id",
            "thread id must not be empty",
        )?;
        let state = self.lock_state()?;
        Ok(state.threads.get(thread_id).cloned())
    }

    pub fn branch_create(
        &self,
        branch_id: &str,
        thread_id: &str,
        from_turn_node_hash: &str,
    ) -> KernelResult<BranchRecord> {
        validate_id(
            branch_id,
            "invalid_branch_id",
            "branch id must not be empty",
        )?;
        validate_id(
            thread_id,
            "invalid_thread_id",
            "thread id must not be empty",
        )?;
        let mut state = self.lock_state()?;
        if state.branches.contains_key(branch_id) {
            return Err(duplicate("branch_already_exists", "branch already exists"));
        }
        ensure_node_belongs_to_thread(&state, from_turn_node_hash, thread_id)?;
        let branch = BranchRecord {
            branch_id: branch_id.to_string(),
            head_turn_node_hash: from_turn_node_hash.to_string(),
            thread_id: thread_id.to_string(),
        };
        state.branches.insert(branch_id.to_string(), branch.clone());
        Ok(branch)
    }

    pub fn branch_get(&self, branch_id: &str) -> KernelResult<Option<BranchRecord>> {
        validate_id(
            branch_id,
            "invalid_branch_id",
            "branch id must not be empty",
        )?;
        let state = self.lock_state()?;
        Ok(state.branches.get(branch_id).cloned())
    }

    pub fn branch_set_head(
        &self,
        branch_id: &str,
        turn_node_hash: &str,
    ) -> KernelResult<SetHeadResult> {
        validate_id(
            branch_id,
            "invalid_branch_id",
            "branch id must not be empty",
        )?;
        let mut state = self.lock_state()?;
        let mut branch = state
            .branches
            .get(branch_id)
            .cloned()
            .ok_or_else(|| missing("branch_not_found", "branch does not exist"))?;
        ensure_node_belongs_to_thread(&state, turn_node_hash, &branch.thread_id)?;
        let prior_head = branch.head_turn_node_hash.clone();
        let moves_forward =
            prior_head == turn_node_hash || is_ancestor(&state, &prior_head, turn_node_hash)?;
        if moves_forward && prior_head != turn_node_hash && branch_has_active_run(&state, branch_id)
        {
            return Err(KernelError::new(
                "branch_has_active_run",
                "branch head cannot move forward while the branch has an active run",
                None,
            ));
        }
        let archive_branch = if moves_forward {
            None
        } else if is_ancestor(&state, turn_node_hash, &prior_head)? {
            let archive_head = reactively_checkpoint_active_runs_on_branch(&mut state, branch_id)?;
            // Backward moves preserve the abandoned head under an archive
            // branch. Any active run staging is first checkpointed onto that
            // abandoned lineage so rollback does not erase durable work.
            let archive_id = next_archive_branch_id(&mut state, branch_id);
            let archive = BranchRecord {
                branch_id: archive_id.clone(),
                head_turn_node_hash: archive_head,
                thread_id: branch.thread_id.clone(),
            };
            state.branches.insert(archive_id, archive.clone());
            // A branch rewind changes the active lineage under running work;
            // fail in-flight runs and clear run-local scratch state so no
            // uncommitted staging survives without a legal checkpoint path.
            fail_active_runs_on_branch(&mut state, branch_id);
            Some(archive)
        } else {
            return Err(KernelError::new(
                "branch_head_lateral_move",
                "branch head can only move along one lineage",
                None,
            ));
        };
        branch.head_turn_node_hash = turn_node_hash.to_string();
        state.branches.insert(branch_id.to_string(), branch.clone());
        Ok(SetHeadResult {
            archive_branch,
            branch,
        })
    }

    pub fn branch_list(&self, thread_id: &str) -> KernelResult<Vec<(String, HashString)>> {
        validate_id(
            thread_id,
            "invalid_thread_id",
            "thread id must not be empty",
        )?;
        let state = self.lock_state()?;
        if !state.threads.contains_key(thread_id) {
            return Err(missing("thread_not_found", "thread does not exist"));
        }
        let mut entries = state
            .branches
            .values()
            .filter(|branch| branch.thread_id == thread_id)
            .map(|branch| (branch.branch_id.clone(), branch.head_turn_node_hash.clone()))
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(entries)
    }

    pub fn turn_create(
        &self,
        turn_id: &str,
        thread_id: &str,
        branch_id: &str,
        parent_turn_id: Option<String>,
        start_turn_node_hash: &str,
    ) -> KernelResult<TurnRecord> {
        validate_id(turn_id, "invalid_turn_id", "turn id must not be empty")?;
        validate_id(
            thread_id,
            "invalid_thread_id",
            "thread id must not be empty",
        )?;
        validate_id(
            branch_id,
            "invalid_branch_id",
            "branch id must not be empty",
        )?;
        if let Some(parent_turn_id) = &parent_turn_id {
            validate_id(
                parent_turn_id,
                "invalid_parent_turn_id",
                "parent turn id must not be empty",
            )?;
        }
        let mut state = self.lock_state()?;
        if state.turns.contains_key(turn_id) {
            return Err(duplicate("turn_already_exists", "turn already exists"));
        }
        let branch = state
            .branches
            .get(branch_id)
            .ok_or_else(|| missing("branch_not_found", "branch does not exist"))?;
        if branch.thread_id != thread_id {
            return Err(KernelError::new(
                "turn_branch_thread_mismatch",
                "turn branch must belong to the requested thread",
                None,
            ));
        }
        ensure_node_belongs_to_thread(&state, start_turn_node_hash, thread_id)?;
        let immediate_same_branch_parent = latest_turn_matching(&state, |turn| {
            turn.thread_id == thread_id
                && turn.branch_id == branch_id
                && turn.head_turn_node_hash == start_turn_node_hash
        });
        let any_parent_at_start = latest_turn_matching(&state, |turn| {
            turn.thread_id == thread_id && turn.head_turn_node_hash == start_turn_node_hash
        });
        if parent_turn_id.is_none() && any_parent_at_start.is_some() {
            return Err(KernelError::new(
                "turn_parent_required",
                "turn parent must reference the previous semantic turn when one exists",
                None,
            ));
        }
        if let Some(parent_turn_id) = &parent_turn_id {
            if let Some(immediate_parent) = immediate_same_branch_parent
                && parent_turn_id != &immediate_parent.turn_id
            {
                return Err(KernelError::new(
                    "turn_parent_not_immediate",
                    "turn parent must be the immediately previous turn on the branch",
                    None,
                ));
            }
            let parent = state
                .turns
                .get(parent_turn_id)
                .ok_or_else(|| missing("parent_turn_not_found", "parent turn does not exist"))?;
            if parent.thread_id != thread_id {
                return Err(KernelError::new(
                    "parent_turn_thread_mismatch",
                    "parent turn must belong to the same thread",
                    None,
                ));
            }
            if parent.head_turn_node_hash != start_turn_node_hash {
                return Err(KernelError::new(
                    "parent_turn_head_mismatch",
                    "child turn must start at the parent turn head",
                    None,
                ));
            }
        }
        let turn = TurnRecord {
            branch_id: branch_id.to_string(),
            head_turn_node_hash: start_turn_node_hash.to_string(),
            parent_turn_id,
            start_turn_node_hash: start_turn_node_hash.to_string(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
        };
        state.turns.insert(turn_id.to_string(), turn.clone());
        // Creation order is the only deterministic way to define "immediate"
        // when multiple semantic turns share the same branch and start node.
        state.turn_order.push(turn_id.to_string());
        Ok(turn)
    }

    pub fn turn_get(&self, turn_id: &str) -> KernelResult<Option<TurnRecord>> {
        validate_id(turn_id, "invalid_turn_id", "turn id must not be empty")?;
        let state = self.lock_state()?;
        Ok(state.turns.get(turn_id).cloned())
    }

    pub fn turn_update_head(&self, turn_id: &str, head_turn_node_hash: &str) -> KernelResult<()> {
        validate_id(turn_id, "invalid_turn_id", "turn id must not be empty")?;
        let mut state = self.lock_state()?;
        let mut turn = state
            .turns
            .get(turn_id)
            .cloned()
            .ok_or_else(|| missing("turn_not_found", "turn does not exist"))?;
        ensure_node_belongs_to_thread(&state, head_turn_node_hash, &turn.thread_id)?;
        if !is_ancestor(&state, &turn.start_turn_node_hash, head_turn_node_hash)? {
            return Err(KernelError::new(
                "turn_head_not_descendant",
                "turn head must remain on or after the turn start node",
                None,
            ));
        }
        if !is_ancestor(&state, &turn.head_turn_node_hash, head_turn_node_hash)? {
            return Err(KernelError::new(
                "turn_head_lateral_move",
                "turn head must advance from the current turn head",
                None,
            ));
        }
        turn.head_turn_node_hash = head_turn_node_hash.to_string();
        state.turns.insert(turn_id.to_string(), turn);
        Ok(())
    }

    pub fn staging_stage(
        &self,
        run_id: &str,
        blob: Vec<u8>,
        task_id: &str,
        object_type: &str,
        status: StagedResultStatus,
        interrupt_payload: Option<KernelRecord>,
    ) -> KernelResult<(HashString, StagedResult)> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let object_hash = hash_bytes_to_hex(&blob);
        let timestamp_ms = (self.now)();
        let staged_result = StagedResult {
            interrupt_payload,
            object_hash: object_hash.clone(),
            object_type: object_type.to_string(),
            status,
            task_id: task_id.to_string(),
            timestamp_ms,
        };
        // Validate the complete record before touching the object store so
        // in-process callers and transport callers share one protocol gate.
        validate_staged_result_profile(&staged_result)?;
        let mut state = self.lock_state()?;
        let run = state
            .runs
            .get(run_id)
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        if run.status != RunStatus::Running {
            return Err(KernelError::new(
                "run_not_running",
                "only running runs can stage results",
                None,
            ));
        }
        if state
            .staged_results
            .get(run_id)
            .is_some_and(|staged_results| {
                staged_results
                    .iter()
                    .any(|existing| existing.task_id == task_id)
            })
        {
            return Err(duplicate(
                "staged_result_task_already_exists",
                "run already has a staged result for this task id",
            ));
        }
        state
            .objects
            .insert(object_hash.clone(), ObjectRecord { blob });
        let staged_results = state.staged_results.entry(run_id.to_string()).or_default();
        staged_results.push(staged_result.clone());
        Ok((object_hash, staged_result))
    }

    pub fn staging_current(&self, run_id: &str) -> KernelResult<Vec<StagedResult>> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let state = self.lock_state()?;
        if !state.runs.contains_key(run_id) {
            return Err(missing("run_not_found", "run does not exist"));
        }
        Ok(state
            .staged_results
            .get(run_id)
            .cloned()
            .unwrap_or_default())
    }

    pub fn run_create(
        &self,
        run_id: &str,
        turn_id: &str,
        branch_id: &str,
        schema_id: &str,
        start_turn_node_hash: &str,
        steps: Vec<StepDeclaration>,
    ) -> KernelResult<RunRecord> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        validate_id(turn_id, "invalid_turn_id", "turn id must not be empty")?;
        validate_id(
            branch_id,
            "invalid_branch_id",
            "branch id must not be empty",
        )?;
        validate_steps(&steps)?;
        let mut state = self.lock_state()?;
        if state.runs.contains_key(run_id) {
            return Err(duplicate("run_already_exists", "run already exists"));
        }
        let branch = state
            .branches
            .get(branch_id)
            .ok_or_else(|| missing("branch_not_found", "branch does not exist"))?;
        if branch.head_turn_node_hash != start_turn_node_hash {
            return Err(KernelError::new(
                "run_start_head_mismatch",
                "run start turn node must match the branch head",
                None,
            ));
        }
        let turn = state
            .turns
            .get(turn_id)
            .ok_or_else(|| missing("turn_not_found", "turn does not exist"))?;
        if turn.branch_id != branch_id {
            return Err(KernelError::new(
                "run_turn_branch_mismatch",
                "run turn must belong to the requested branch",
                None,
            ));
        }
        if !is_ancestor(&state, &turn.start_turn_node_hash, start_turn_node_hash)?
            || !is_ancestor(&state, start_turn_node_hash, &turn.head_turn_node_hash)?
        {
            return Err(KernelError::new(
                "run_turn_span_mismatch",
                "run start node must be inside the referenced turn span",
                None,
            ));
        }
        if !state.schemas.contains_key(schema_id) {
            return Err(missing("schema_not_found", "schema does not exist"));
        }
        let start_node = state
            .turn_nodes
            .get(start_turn_node_hash)
            .ok_or_else(|| missing("turn_node_not_found", "run start turn node does not exist"))?;
        if start_node.schema_id != schema_id {
            return Err(KernelError::new(
                "run_schema_mismatch",
                "run schema must match the start turn node schema",
                None,
            ));
        }
        if state.runs.values().any(|run| {
            run.branch_id == branch_id
                && matches!(run.status, RunStatus::Running | RunStatus::Paused)
        }) {
            return Err(KernelError::new(
                "branch_has_active_run",
                "branch already has a running or paused run",
                None,
            ));
        }
        let run = RunRecord {
            branch_id: branch_id.to_string(),
            created_turn_nodes: Vec::new(),
            current_step_index: 0,
            run_id: run_id.to_string(),
            schema_id: schema_id.to_string(),
            start_turn_node_hash: start_turn_node_hash.to_string(),
            status: RunStatus::Running,
            step_sequence: steps,
            turn_id: turn_id.to_string(),
        };
        state.runs.insert(run_id.to_string(), run.clone());
        Ok(run)
    }

    pub fn run_begin_step(&self, run_id: &str, step_id: &str) -> KernelResult<StepContext> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let mut state = self.lock_state()?;
        let (current_turn_node_hash, schema_id, step) = {
            let run = state
                .runs
                .get(run_id)
                .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
            if run.status != RunStatus::Running {
                return Err(KernelError::new(
                    "run_not_running",
                    "only running runs can begin steps",
                    None,
                ));
            }
            let step = run
                .step_sequence
                .get(run.current_step_index)
                .ok_or_else(|| missing("run_step_not_found", "run has no current step"))?;
            if step.id != step_id {
                return Err(KernelError::new(
                    "run_step_mismatch",
                    "requested step id must match the current run step",
                    None,
                ));
            }
            (
                run_active_turn_node_hash(run),
                run.schema_id.clone(),
                step.clone(),
            )
        };
        let schema = state
            .schemas
            .get(&schema_id)
            .cloned()
            .ok_or_else(|| missing("schema_not_found", "schema does not exist"))?;
        let signals = state.run_signals.remove(run_id).unwrap_or_default();
        Ok(StepContext {
            current_turn_node_hash,
            schema,
            // Observe signals are ephemeral run-local inputs for exactly the
            // next step begin; consuming them here prevents stale replays.
            signals,
            step,
        })
    }

    pub fn run_complete_step(
        &self,
        run_id: &str,
        step_id: &str,
        event_hash: Option<String>,
        observe_results: Vec<ObserveResult>,
        tree_hash: Option<String>,
    ) -> KernelResult<(bool, Option<HashString>)> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let mut state = self.lock_state()?;
        let mut run = state
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        if run.status != RunStatus::Running {
            return Err(KernelError::new(
                "run_not_running",
                "only running runs can complete steps",
                None,
            ));
        }
        ensure_run_active_at_branch_head(&state, &run)?;
        let step = run
            .step_sequence
            .get(run.current_step_index)
            .ok_or_else(|| missing("run_step_not_found", "run has no current step"))?;
        if step.id != step_id {
            return Err(KernelError::new(
                "run_step_mismatch",
                "completed step id must match the current run step",
                None,
            ));
        }
        for annotation in observe_results
            .iter()
            .flat_map(|observe_result| observe_result.annotations.iter())
        {
            let object_hash = hash_bytes_to_hex(annotation);
            state.objects.insert(
                object_hash,
                ObjectRecord {
                    blob: annotation.clone(),
                },
            );
        }
        ensure_event_hash_exists(&state, event_hash.as_deref())?;
        let next_signals = observe_results
            .iter()
            .flat_map(|observe_result| observe_result.signals.iter().cloned())
            .collect::<Vec<_>>();
        let staged_results = state
            .staged_results
            .get(run_id)
            .cloned()
            .unwrap_or_default();
        let checkpoint_required = !step.deterministic
            || step.side_effects
            || event_hash.is_some()
            || tree_hash.is_some()
            || !observe_results.is_empty()
            || !staged_results.is_empty();

        if !checkpoint_required {
            run.current_step_index += 1;
            set_next_step_signals(&mut state, run_id, next_signals);
            state.runs.insert(run_id.to_string(), run);
            return Ok((false, None));
        }

        let prior_node = state
            .turn_nodes
            .get(&run_active_turn_node_hash(&run))
            .cloned()
            .ok_or_else(|| missing("turn_node_not_found", "run active turn node does not exist"))?;
        let next_tree_hash = match tree_hash {
            Some(tree_hash) => {
                ensure_turn_tree_schema(&state, &tree_hash, &run.schema_id)?;
                tree_hash
            }
            None => incorporate_locked(&mut state, &prior_node.turn_tree_hash, &staged_results)?,
        };
        let mut node = TurnNode {
            consumed_staged_results: staged_results,
            event_hash,
            hash: String::new(),
            previous_turn_node_hash: Some(prior_node.hash),
            schema_id: run.schema_id.clone(),
            turn_tree_hash: next_tree_hash,
        };
        node.hash = hash_turn_node_identity(&node)?;
        state.turn_nodes.insert(node.hash.clone(), node.clone());
        run.created_turn_nodes.push(node.hash.clone());
        run.current_step_index += 1;
        set_run_head_refs(&mut state, &run, &node.hash)?;
        // Staged results are cleared only after the checkpoint node and head
        // refs commit, preserving retry/recovery state on validation failures.
        state.staged_results.remove(run_id);
        set_next_step_signals(&mut state, run_id, next_signals);
        state.runs.insert(run_id.to_string(), run);
        Ok((true, Some(node.hash)))
    }

    pub fn run_complete(
        &self,
        run_id: &str,
        status: RunCompletionStatus,
        event_hash: Option<String>,
    ) -> KernelResult<Option<HashString>> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let mut state = self.lock_state()?;
        let mut run = state
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        let terminal_status = match status {
            RunCompletionStatus::Paused => RunStatus::Paused,
            RunCompletionStatus::Completed => RunStatus::Completed,
            RunCompletionStatus::Failed => RunStatus::Failed,
        };
        validate_run_completion_transition(&run.status, &terminal_status)?;
        if terminal_status == RunStatus::Completed
            && run.current_step_index != run.step_sequence.len()
        {
            return Err(KernelError::new(
                "run_steps_incomplete",
                "completed runs must exhaust their declared step sequence",
                None,
            ));
        }
        let staged_results = state
            .staged_results
            .get(run_id)
            .cloned()
            .unwrap_or_default();
        ensure_event_hash_exists(&state, event_hash.as_deref())?;
        let checkpoint_required = event_hash.is_some() || !staged_results.is_empty();
        let terminal_hash = if checkpoint_required {
            let prior_node = state
                .turn_nodes
                .get(&run_active_turn_node_hash(&run))
                .cloned()
                .ok_or_else(|| {
                    missing("turn_node_not_found", "run active turn node does not exist")
                })?;
            let next_tree_hash = if staged_results.is_empty() {
                prior_node.turn_tree_hash.clone()
            } else {
                incorporate_locked(&mut state, &prior_node.turn_tree_hash, &staged_results)?
            };
            let mut node = TurnNode {
                consumed_staged_results: staged_results,
                event_hash,
                hash: String::new(),
                previous_turn_node_hash: Some(prior_node.hash),
                schema_id: run.schema_id.clone(),
                turn_tree_hash: next_tree_hash,
            };
            node.hash = hash_turn_node_identity(&node)?;
            state.turn_nodes.insert(node.hash.clone(), node.clone());
            run.created_turn_nodes.push(node.hash.clone());
            set_run_head_refs(&mut state, &run, &node.hash)?;
            // Terminal checkpointing consumes unanchored staged work before the
            // run halts, keeping recovery and branch head state coherent.
            state.staged_results.remove(run_id);
            Some(node.hash)
        } else {
            None
        };
        state.run_signals.remove(run_id);
        run.status = terminal_status;
        state.runs.insert(run_id.to_string(), run);
        Ok(terminal_hash)
    }

    pub fn run_recover(&self, run_id: &str) -> KernelResult<RecoveryState> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let state = self.lock_state()?;
        let run = state
            .runs
            .get(run_id)
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        let consumed_staged_results = run
            .created_turn_nodes
            .last()
            .map(|node_hash| {
                state
                    .turn_nodes
                    .get(node_hash)
                    .ok_or_else(|| missing("turn_node_not_found", "run turn node does not exist"))
                    .map(|node| node.consumed_staged_results.clone())
            })
            .transpose()?
            .unwrap_or_default();
        let last_completed_step_id = run
            .current_step_index
            .checked_sub(1)
            .and_then(|index| run.step_sequence.get(index))
            .map(|step| step.id.clone());
        Ok(RecoveryState {
            consumed_staged_results,
            last_completed_step_id,
            last_turn_node_hash: run_active_turn_node_hash(run),
            step_sequence: run.step_sequence.clone(),
            uncommitted_staged_results: state
                .staged_results
                .get(run_id)
                .cloned()
                .unwrap_or_default(),
        })
    }

    pub fn verdicts_compose(&self, verdicts: Vec<Verdict>) -> KernelResult<Verdict> {
        let mut abort = None;
        let mut pause = None;
        let mut modifies = Vec::new();
        let mut retry = None;
        for verdict in verdicts {
            match verdict {
                Verdict::Abort { .. } if abort.is_none() => abort = Some(verdict),
                Verdict::Pause { .. } if pause.is_none() => pause = Some(verdict),
                Verdict::Modify { transform } => modifies.push(transform),
                Verdict::Retry { .. } if retry.is_none() => retry = Some(verdict),
                _ => {}
            }
        }
        let modify = match modifies.len() {
            0 => None,
            1 => modifies
                .into_iter()
                .next()
                .map(|transform| Verdict::Modify { transform }),
            _ => Some(Verdict::Modify {
                // Transforms are opaque to the kernel; wrapping multiple
                // transforms in order preserves registration sequencing
                // without inventing transform-specific merge semantics.
                transform: KernelRecord::Array(modifies),
            }),
        };
        Ok(abort
            .or(pause)
            .or(modify)
            .or(retry)
            .unwrap_or(Verdict::Proceed))
    }

    fn lock_state(&self) -> KernelResult<std::sync::MutexGuard<'_, KernelState>> {
        self.state.lock().map_err(|_| {
            KernelError::new(
                "kernel_state_poisoned",
                "in-memory kernel state lock was poisoned",
                None,
            )
        })
    }
}

fn incorporate_locked(
    state: &mut KernelState,
    base_turn_tree_hash: &str,
    staged_results: &[StagedResult],
) -> KernelResult<HashString> {
    let base_tree = state
        .turn_trees
        .get(base_turn_tree_hash)
        .cloned()
        .ok_or_else(|| missing("turn_tree_not_found", "base turn tree does not exist"))?;
    let schema = state
        .schemas
        .get(&base_tree.schema_id)
        .cloned()
        .ok_or_else(|| missing("schema_not_found", "turn tree schema does not exist"))?;
    let mut manifest = base_tree.manifest;
    for staged_result in staged_results {
        validate_staged_result_durable(state, staged_result)?;
        let rule = schema
            .incorporation_rules
            .iter()
            .find(|rule| rule.object_type == staged_result.object_type)
            .ok_or_else(|| {
                KernelError::new(
                    "incorporation_rule_not_found",
                    "staged result object type has no incorporation rule",
                    None,
                )
            })?;
        apply_incorporation_rule(&schema, &mut manifest, rule, staged_result)?;
    }
    let tree_hash = hash_turn_tree_identity(&schema.schema_id, &manifest)?;
    state.turn_trees.insert(
        tree_hash.clone(),
        StoredTurnTree {
            manifest,
            schema_id: schema.schema_id,
        },
    );
    Ok(tree_hash)
}

fn reactively_checkpoint_active_runs_on_branch(
    state: &mut KernelState,
    branch_id: &str,
) -> KernelResult<HashString> {
    let run_ids = state
        .runs
        .values()
        .filter(|run| {
            run.branch_id == branch_id
                && matches!(run.status, RunStatus::Running | RunStatus::Paused)
        })
        .map(|run| run.run_id.clone())
        .collect::<Vec<_>>();
    let mut archive_head = state
        .branches
        .get(branch_id)
        .ok_or_else(|| missing("branch_not_found", "branch does not exist"))?
        .head_turn_node_hash
        .clone();

    for run_id in run_ids {
        let staged_results = state
            .staged_results
            .get(&run_id)
            .cloned()
            .unwrap_or_default();
        if staged_results.is_empty() {
            continue;
        }
        let run = state
            .runs
            .get(&run_id)
            .cloned()
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        let prior_node = state
            .turn_nodes
            .get(&run_active_turn_node_hash(&run))
            .cloned()
            .ok_or_else(|| missing("turn_node_not_found", "run active turn node does not exist"))?;
        let next_tree_hash =
            incorporate_locked(state, &prior_node.turn_tree_hash, &staged_results)?;
        let mut node = TurnNode {
            consumed_staged_results: staged_results,
            event_hash: None,
            hash: String::new(),
            previous_turn_node_hash: Some(prior_node.hash),
            schema_id: run.schema_id.clone(),
            turn_tree_hash: next_tree_hash,
        };
        node.hash = hash_turn_node_identity(&node)?;
        state.turn_nodes.insert(node.hash.clone(), node.clone());
        if let Some(run) = state.runs.get_mut(&run_id) {
            run.created_turn_nodes.push(node.hash.clone());
        }
        // The checkpoint becomes the archive head; the original branch is
        // rewound immediately after archival, so the new node is not lost.
        let run = state
            .runs
            .get(&run_id)
            .cloned()
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        set_run_head_refs(state, &run, &node.hash)?;
        archive_head = node.hash;
    }

    Ok(archive_head)
}

fn set_run_head_refs(
    state: &mut KernelState,
    run: &RunRecord,
    head_turn_node_hash: &str,
) -> KernelResult<()> {
    let branch = state
        .branches
        .get_mut(&run.branch_id)
        .ok_or_else(|| missing("branch_not_found", "run branch does not exist"))?;
    branch.head_turn_node_hash = head_turn_node_hash.to_string();
    let turn = state
        .turns
        .get_mut(&run.turn_id)
        .ok_or_else(|| missing("turn_not_found", "run turn does not exist"))?;
    turn.head_turn_node_hash = head_turn_node_hash.to_string();
    Ok(())
}

fn fail_active_runs_on_branch(state: &mut KernelState, branch_id: &str) {
    let mut failed_run_ids = Vec::new();
    for run in state.runs.values_mut().filter(|run| {
        run.branch_id == branch_id && matches!(run.status, RunStatus::Running | RunStatus::Paused)
    }) {
        run.status = RunStatus::Failed;
        failed_run_ids.push(run.run_id.clone());
    }
    for run_id in failed_run_ids {
        state.staged_results.remove(&run_id);
        state.run_signals.remove(&run_id);
    }
}

fn branch_has_active_run(state: &KernelState, branch_id: &str) -> bool {
    state.runs.values().any(|run| {
        run.branch_id == branch_id && matches!(run.status, RunStatus::Running | RunStatus::Paused)
    })
}

fn latest_turn_matching(
    state: &KernelState,
    mut predicate: impl FnMut(&TurnRecord) -> bool,
) -> Option<TurnRecord> {
    state
        .turn_order
        .iter()
        .rev()
        .filter_map(|turn_id| state.turns.get(turn_id))
        .find(|turn| predicate(turn))
        .cloned()
}

fn ensure_run_active_at_branch_head(state: &KernelState, run: &RunRecord) -> KernelResult<()> {
    let branch = state
        .branches
        .get(&run.branch_id)
        .ok_or_else(|| missing("branch_not_found", "run branch does not exist"))?;
    let active_turn_node_hash = run_active_turn_node_hash(run);
    if branch.head_turn_node_hash != active_turn_node_hash {
        return Err(KernelError::new(
            "run_branch_head_mismatch",
            "run active turn node must match the current branch head",
            None,
        ));
    }
    Ok(())
}

fn next_archive_branch_id(state: &mut KernelState, branch_id: &str) -> String {
    loop {
        state.archive_counter += 1;
        let archive_id = format!("{branch_id}_archive_{}", state.archive_counter);
        if !state.branches.contains_key(&archive_id) {
            return archive_id;
        }
    }
}

fn set_next_step_signals(state: &mut KernelState, run_id: &str, signals: Vec<KernelRecord>) {
    if signals.is_empty() {
        state.run_signals.remove(run_id);
    } else {
        state.run_signals.insert(run_id.to_string(), signals);
    }
}

fn ensure_event_hash_exists(state: &KernelState, event_hash: Option<&str>) -> KernelResult<()> {
    if let Some(event_hash) = event_hash
        && !state.objects.contains_key(event_hash)
    {
        return Err(missing(
            "event_object_not_found",
            "event hash must reference an existing object",
        ));
    }
    Ok(())
}

fn ensure_turn_tree_schema(
    state: &KernelState,
    tree_hash: &str,
    schema_id: &str,
) -> KernelResult<()> {
    let tree = state
        .turn_trees
        .get(tree_hash)
        .ok_or_else(|| missing("turn_tree_not_found", "provided turn tree does not exist"))?;
    if tree.schema_id != schema_id {
        return Err(KernelError::new(
            "turn_tree_schema_mismatch",
            "provided turn tree schema must match the run schema",
            None,
        ));
    }
    Ok(())
}

fn validate_run_completion_transition(
    current: &RunStatus,
    terminal: &RunStatus,
) -> KernelResult<()> {
    match (current, terminal) {
        (RunStatus::Running, RunStatus::Paused | RunStatus::Completed | RunStatus::Failed)
        | (RunStatus::Paused, RunStatus::Failed) => Ok(()),
        _ => Err(KernelError::new(
            "invalid_run_completion_transition",
            "run completion status transition is not allowed",
            None,
        )),
    }
}

fn run_active_turn_node_hash(run: &RunRecord) -> HashString {
    run.created_turn_nodes
        .last()
        .cloned()
        .unwrap_or_else(|| run.start_turn_node_hash.clone())
}

fn empty_manifest(schema: &TurnTreeSchema) -> TurnTreeManifest {
    schema
        .paths
        .iter()
        .map(|path| {
            (
                path.path.clone(),
                match path.collection {
                    PathCollectionKind::Ordered => PathValue::Ordered(Vec::new()),
                    PathCollectionKind::Single => PathValue::Null,
                },
            )
        })
        .collect()
}

fn apply_changes(
    schema: &TurnTreeSchema,
    manifest: &mut TurnTreeManifest,
    changes: TurnTreeManifest,
) -> KernelResult<()> {
    for (path, value) in changes {
        let definition = schema
            .paths
            .iter()
            .find(|definition| definition.path == path)
            .ok_or_else(|| missing("turn_tree_path_not_found", "turn tree path does not exist"))?;
        validate_path_value(definition.collection.clone(), &value)?;
        manifest.insert(path, value);
    }
    Ok(())
}

fn ensure_complete_tree_create_changes(
    schema: &TurnTreeSchema,
    changes: &TurnTreeManifest,
) -> KernelResult<()> {
    for definition in &schema.paths {
        let value = changes.get(&definition.path).ok_or_else(|| {
            KernelError::new(
                "incomplete_turn_tree_manifest",
                "tree create without a base must provide every schema path",
                None,
            )
        })?;
        validate_path_value(definition.collection.clone(), value)?;
    }
    Ok(())
}

fn apply_incorporation_rule(
    schema: &TurnTreeSchema,
    manifest: &mut TurnTreeManifest,
    rule: &IncorporationRule,
    staged_result: &StagedResult,
) -> KernelResult<()> {
    let definition = schema
        .paths
        .iter()
        .find(|definition| definition.path == rule.target_path)
        .ok_or_else(|| missing("turn_tree_path_not_found", "target path does not exist"))?;
    match definition.collection {
        PathCollectionKind::Ordered => match manifest.get_mut(&rule.target_path) {
            Some(PathValue::Ordered(values)) => values.push(staged_result.object_hash.clone()),
            _ => {
                return Err(KernelError::new(
                    "invalid_ordered_path_state",
                    "ordered path must contain a hash list",
                    None,
                ));
            }
        },
        PathCollectionKind::Single => {
            manifest.insert(
                rule.target_path.clone(),
                PathValue::Single(staged_result.object_hash.clone()),
            );
        }
    }
    Ok(())
}

fn validate_path_value(collection: PathCollectionKind, value: &PathValue) -> KernelResult<()> {
    match (collection, value) {
        (PathCollectionKind::Ordered, PathValue::Ordered(values)) => {
            for value in values {
                validate_hash_string(value)?;
            }
            Ok(())
        }
        (PathCollectionKind::Single, PathValue::Single(value)) => validate_hash_string(value),
        (PathCollectionKind::Single, PathValue::Null) => Ok(()),
        _ => Err(KernelError::new(
            "invalid_path_value_kind",
            "path value does not match path collection kind",
            None,
        )),
    }
}

fn validate_staged_result_profile(staged_result: &StagedResult) -> KernelResult<()> {
    validate_non_empty(
        &staged_result.task_id,
        "invalid_task_id",
        "task id must not be empty",
    )?;
    validate_non_empty(
        &staged_result.object_type,
        "invalid_object_type",
        "object type must not be empty",
    )?;
    validate_hash_string(&staged_result.object_hash)?;
    validate_epoch_ms(staged_result.timestamp_ms)?;
    if matches!(staged_result.status, StagedResultStatus::Interrupted)
        != staged_result.interrupt_payload.is_some()
    {
        return Err(KernelError::new(
            "invalid_staged_result_outcome",
            "only interrupted staged results may carry interrupt payloads",
            None,
        ));
    }
    if let Some(interrupt_payload) = staged_result.interrupt_payload.as_ref() {
        // Run-local payloads become identity material at checkpoint time; keep
        // external tree.incorporate inputs inside the same deterministic CBOR
        // profile enforced by staging_stage.
        encode_deterministic_kernel_record(interrupt_payload)?;
    }
    Ok(())
}

fn validate_staged_result_durable(
    state: &KernelState,
    staged_result: &StagedResult,
) -> KernelResult<()> {
    validate_staged_result_profile(staged_result)?;
    if !state.objects.contains_key(&staged_result.object_hash) {
        return Err(missing(
            "staged_object_not_found",
            "staged result object hash must reference an existing object",
        ));
    }
    Ok(())
}

fn validate_epoch_ms(value: EpochMs) -> KernelResult<()> {
    if (MIN_SAFE_EPOCH_MS..=MAX_SAFE_EPOCH_MS).contains(&value) {
        Ok(())
    } else {
        Err(KernelError::new(
            "invalid_epoch_ms",
            "epoch milliseconds must be a JavaScript-safe integer",
            None,
        ))
    }
}

fn validate_hash_string(hash: &str) -> KernelResult<()> {
    if hash.len() == 64
        && hash
            .as_bytes()
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(KernelError::new(
            "invalid_hash_string",
            "hash must be a lowercase 64-character SHA-256 hex digest",
            None,
        ))
    }
}

fn validate_id(value: &str, code: &'static str, message: &'static str) -> KernelResult<()> {
    validate_non_empty(value, code, message)
}

fn validate_schema(schema: &TurnTreeSchema) -> KernelResult<()> {
    validate_non_empty(
        &schema.schema_id,
        "invalid_schema_id",
        "schema id must not be empty",
    )?;
    let mut paths = HashSet::new();
    let mut object_types = HashSet::new();
    for path in &schema.paths {
        validate_non_empty(
            &path.path,
            "invalid_schema_path",
            "schema path must not be empty",
        )?;
        if let Some(metadata) = &path.metadata {
            // Schema metadata participates in governed records, so reject
            // values outside the canonical CBOR profile before registration.
            encode_deterministic_kernel_record(metadata)?;
        }
        if !paths.insert(path.path.clone()) {
            return Err(duplicate(
                "duplicate_schema_path",
                "schema paths must be unique",
            ));
        }
    }
    for rule in &schema.incorporation_rules {
        validate_non_empty(
            &rule.object_type,
            "invalid_incorporation_rule",
            "incorporation rule object type must not be empty",
        )?;
        if !object_types.insert(rule.object_type.clone()) {
            return Err(duplicate(
                "duplicate_incorporation_rule_object_type",
                "incorporation rule object types must be unique",
            ));
        }
        if !paths.contains(&rule.target_path) {
            return Err(KernelError::new(
                "invalid_incorporation_rule_target",
                "incorporation rule target path must exist in schema paths",
                None,
            ));
        }
    }
    Ok(())
}

fn validate_steps(steps: &[StepDeclaration]) -> KernelResult<()> {
    if steps.is_empty() {
        return Err(KernelError::new(
            "invalid_step_sequence",
            "run step sequence must not be empty",
            None,
        ));
    }
    let mut ids = HashSet::new();
    for step in steps {
        validate_non_empty(&step.id, "invalid_step_id", "step id must not be empty")?;
        if let Some(metadata) = &step.metadata {
            // Step declarations are part of the recoverable protocol surface;
            // validating now keeps later identity/transport encoding total.
            encode_deterministic_kernel_record(metadata)?;
        }
        if !ids.insert(step.id.clone()) {
            return Err(duplicate("duplicate_step_id", "step ids must be unique"));
        }
    }
    Ok(())
}

fn ensure_node_belongs_to_thread(
    state: &KernelState,
    turn_node_hash: &str,
    thread_id: &str,
) -> KernelResult<()> {
    let thread = state
        .threads
        .get(thread_id)
        .ok_or_else(|| missing("thread_not_found", "thread does not exist"))?;
    let mut next_hash = Some(turn_node_hash.to_string());
    while let Some(hash) = next_hash {
        let node = state
            .turn_nodes
            .get(&hash)
            .ok_or_else(|| missing("turn_node_not_found", "turn node does not exist"))?;
        if hash == thread.root_turn_node_hash {
            return Ok(());
        }
        next_hash = node.previous_turn_node_hash.clone();
    }
    Err(KernelError::new(
        "turn_node_thread_mismatch",
        "turn node does not belong to the requested thread",
        None,
    ))
}

fn is_ancestor(
    state: &KernelState,
    ancestor_hash: &str,
    descendant_hash: &str,
) -> KernelResult<bool> {
    let mut next_hash = Some(descendant_hash.to_string());
    while let Some(hash) = next_hash {
        if hash == ancestor_hash {
            return Ok(true);
        }
        let node = state
            .turn_nodes
            .get(&hash)
            .ok_or_else(|| missing("turn_node_not_found", "turn node does not exist"))?;
        next_hash = node.previous_turn_node_hash.clone();
    }
    Ok(false)
}

fn validate_non_empty(value: &str, code: &str, message: &str) -> KernelResult<()> {
    if value.is_empty() {
        Err(KernelError::new(code, message, None))
    } else {
        Ok(())
    }
}

fn duplicate(code: &str, message: &str) -> KernelError {
    KernelError::new(code, message, None)
}

fn missing(code: &str, message: &str) -> KernelError {
    KernelError::new(code, message, None)
}

fn default_now_ms() -> EpochMs {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::types::TurnTreeSchema;

    fn minimal_schema(schema_id: &str) -> TurnTreeSchema {
        TurnTreeSchema {
            incorporation_rules: vec![],
            paths: vec![],
            schema_id: schema_id.to_string(),
        }
    }

    /// Build a kernel whose `now` clock returns successive values from a
    /// pre-defined list so tests produce deterministic `created_at_ms` stamps.
    fn kernel_with_clock(ticks: &[EpochMs]) -> InMemoryKernel {
        let ticks = Arc::new(Mutex::new(ticks.to_vec()));
        let idx = Arc::new(Mutex::new(0usize));
        InMemoryKernel::with_options(InMemoryKernelOptions {
            now: Some(Arc::new(move || {
                let mut i = idx.lock().unwrap();
                let t = ticks.lock().unwrap();
                let v = t[*i];
                *i = (*i + 1).min(t.len() - 1);
                v
            })),
        })
    }

    /// Create a thread and its initial branch; returns the thread_id.
    fn make_thread(kernel: &InMemoryKernel, thread_id: &str, schema_id: &str) -> String {
        let branch_id = format!("{thread_id}-b");
        kernel
            .thread_create(thread_id, schema_id, &branch_id)
            .expect("thread_create");
        thread_id.to_string()
    }

    #[test]
    fn thread_list_empty_returns_no_entries() {
        let kernel = InMemoryKernel::new();
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        let (entries, cursor) = kernel
            .thread_list(ThreadListOptions::default())
            .expect("thread_list");
        assert!(entries.is_empty());
        assert!(cursor.is_none());
    }

    #[test]
    fn thread_list_returns_all_threads_sorted_by_created_at_then_id() {
        // Three threads: t2 earliest, t3 middle, t1 latest (by clock tick).
        // Alphabetically t1 < t2 < t3, but order is by created_at_ms first.
        let kernel = kernel_with_clock(&[100, 200, 300]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        make_thread(&kernel, "t2", "s1"); // tick 100
        make_thread(&kernel, "t3", "s1"); // tick 200
        make_thread(&kernel, "t1", "s1"); // tick 300

        let (entries, cursor) = kernel
            .thread_list(ThreadListOptions::default())
            .expect("thread_list");

        assert_eq!(cursor, None);
        let ids: Vec<&str> = entries.iter().map(|e| e.thread_id.as_str()).collect();
        assert_eq!(ids, vec!["t2", "t3", "t1"]);
        assert_eq!(entries[0].created_at_ms, 100);
        assert_eq!(entries[1].created_at_ms, 200);
        assert_eq!(entries[2].created_at_ms, 300);
    }

    #[test]
    fn thread_list_tie_broken_alphabetically_by_thread_id() {
        // Two threads share the same tick; thread_id breaks the tie.
        let kernel = kernel_with_clock(&[500, 500]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        make_thread(&kernel, "zz", "s1"); // tick 500
        make_thread(&kernel, "aa", "s1"); // tick 500

        let (entries, _) = kernel
            .thread_list(ThreadListOptions::default())
            .expect("thread_list");

        let ids: Vec<&str> = entries.iter().map(|e| e.thread_id.as_str()).collect();
        assert_eq!(ids, vec!["aa", "zz"]);
    }

    #[test]
    fn thread_list_limit_returns_page_and_cursor() {
        let kernel = kernel_with_clock(&[10, 20, 30]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        make_thread(&kernel, "a", "s1"); // tick 10
        make_thread(&kernel, "b", "s1"); // tick 20
        make_thread(&kernel, "c", "s1"); // tick 30

        let (page, cursor) = kernel
            .thread_list(ThreadListOptions {
                limit: Some(2),
                ..Default::default()
            })
            .expect("thread_list page 1");

        let ids: Vec<&str> = page.iter().map(|e| e.thread_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert_eq!(cursor, Some((20, "b".to_string())));
    }

    #[test]
    fn thread_list_cursor_continues_from_previous_page() {
        let kernel = kernel_with_clock(&[10, 20, 30]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        make_thread(&kernel, "a", "s1");
        make_thread(&kernel, "b", "s1");
        make_thread(&kernel, "c", "s1");

        // Fetch page 1
        let (_, cursor) = kernel
            .thread_list(ThreadListOptions {
                limit: Some(2),
                ..Default::default()
            })
            .expect("page 1");

        // Fetch page 2 using cursor
        let (page2, cursor2) = kernel
            .thread_list(ThreadListOptions {
                limit: Some(2),
                cursor,
                ..Default::default()
            })
            .expect("page 2");

        let ids: Vec<&str> = page2.iter().map(|e| e.thread_id.as_str()).collect();
        assert_eq!(ids, vec!["c"]);
        assert_eq!(cursor2, None, "no further pages");
    }

    #[test]
    fn thread_list_filter_by_schema_id() {
        let kernel = kernel_with_clock(&[1, 2, 3]);
        kernel
            .schema_register(minimal_schema("schema-a"))
            .expect("schema a");
        kernel
            .schema_register(minimal_schema("schema-b"))
            .expect("schema b");
        make_thread(&kernel, "t-a1", "schema-a");
        make_thread(&kernel, "t-b1", "schema-b");
        make_thread(&kernel, "t-a2", "schema-a");

        let (entries, _) = kernel
            .thread_list(ThreadListOptions {
                filter_schema_id: Some("schema-a".to_string()),
                ..Default::default()
            })
            .expect("filtered list");

        let ids: Vec<&str> = entries.iter().map(|e| e.thread_id.as_str()).collect();
        assert_eq!(ids, vec!["t-a1", "t-a2"]);
        assert!(entries.iter().all(|e| e.schema_id == "schema-a"));
    }

    #[test]
    fn thread_list_limit_exact_fit_returns_no_cursor() {
        let kernel = kernel_with_clock(&[10, 20]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        make_thread(&kernel, "x", "s1");
        make_thread(&kernel, "y", "s1");

        let (entries, cursor) = kernel
            .thread_list(ThreadListOptions {
                limit: Some(2),
                ..Default::default()
            })
            .expect("thread_list");

        assert_eq!(entries.len(), 2);
        assert_eq!(cursor, None, "exactly limit entries means no next page");
    }

    #[test]
    fn capabilities_advertises_thread_enumeration() {
        let kernel = InMemoryKernel::new();
        assert!(kernel.capabilities().thread_enumeration);
    }
}
