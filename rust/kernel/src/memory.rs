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
    LeasedRunCreateInput, ObserveResult, PathCollectionKind, PathValue, ReclamationSummary,
    RecoveryState, RunCompletionStatus, RunRecord, RunStatus, SetHeadResult, StagedResult,
    StagedResultStatus, StepContext, StepDeclaration, ThreadCreateResult, ThreadRecord, TurnNode,
    TurnRecord, TurnTreeManifest, TurnTreeSchema, Verdict,
};

const MIN_SAFE_EPOCH_MS: EpochMs = -9_007_199_254_740_991;
const MAX_SAFE_EPOCH_MS: EpochMs = 9_007_199_254_740_991;

/// KRT-BK002/ADR-050/ADR-051: a leaseless running run whose `updated_at_ms`
/// has gone quiet for at least this long is treated as abandoned by a
/// crashed/disconnected creator and excluded from pinning the reclamation
/// grace horizon. Mirrors the TypeScript `LEASELESS_RUN_EXPIRY_MS` (24h).
const LEASELESS_RUN_EXPIRY_MS: EpochMs = 86_400_000;

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
    created_at_ms: EpochMs,
}

#[derive(Clone, Debug)]
struct StoredTurnTree {
    created_at_ms: EpochMs,
    manifest: TurnTreeManifest,
    schema_id: String,
}

/// KRT-BK010 reachability-reclamation keep closure. No `chunks` set: the Rust
/// in-memory kernel's `StoredTurnTree.manifest` is already the fully-resolved
/// manifest with no separate ordered-path-chunk records to track.
struct KeepClosure {
    objects: HashSet<HashString>,
    turn_nodes: HashSet<HashString>,
    turn_trees: HashSet<HashString>,
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
    fencing_token_counter: u64,
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
        let created_at_ms = (self.now)();
        let mut state = self.lock_state()?;
        state.objects.insert(
            object_hash.clone(),
            ObjectRecord {
                blob,
                created_at_ms,
            },
        );
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
                created_at_ms: (self.now)(),
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
                created_at_ms: (self.now)(),
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
        let created_at_ms = (self.now)();
        let manifest = empty_manifest(&schema);
        let root_turn_tree_hash = hash_turn_tree_identity(schema_id, &manifest)?;
        state.turn_trees.insert(
            root_turn_tree_hash.clone(),
            StoredTurnTree {
                created_at_ms,
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
                created_at_ms,
            },
        );
        let mut root_node = TurnNode {
            consumed_staged_results: Vec::new(),
            created_at_ms,
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
                archived_from_branch_id: None,
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
            archived_from_branch_id: None,
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
            let archive_head =
                reactively_checkpoint_active_runs_on_branch(&mut state, branch_id, (self.now)())?;
            // Backward moves preserve the abandoned head under an archive
            // branch. Any active run staging is first checkpointed onto that
            // abandoned lineage so rollback does not erase durable work.
            let archive_id = next_archive_branch_id(&mut state, branch_id);
            let archive = BranchRecord {
                archived_from_branch_id: Some(branch_id.to_string()),
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
        state.objects.insert(
            object_hash.clone(),
            ObjectRecord {
                blob,
                created_at_ms: timestamp_ms,
            },
        );
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
        validate_run_creation(&state, branch_id, turn_id, schema_id, start_turn_node_hash)?;
        let now_ms = (self.now)();
        let run = RunRecord {
            branch_id: branch_id.to_string(),
            created_at_ms: now_ms,
            created_turn_nodes: Vec::new(),
            current_step_index: 0,
            execution_owner_id: None,
            fencing_token: None,
            lease_expires_at_ms: None,
            preemption_reason: None,
            run_id: run_id.to_string(),
            schema_id: schema_id.to_string(),
            start_turn_node_hash: start_turn_node_hash.to_string(),
            status: RunStatus::Running,
            step_sequence: steps,
            turn_id: turn_id.to_string(),
            updated_at_ms: now_ms,
        };
        state.runs.insert(run_id.to_string(), run.clone());
        Ok(run)
    }

    /// KRT-BK010 (`kernel.run-liveness`): creates a run with an initial
    /// execution lease (owner, fencing token, expiry) so a caller can prove
    /// exclusive ownership and detect/preempt a stalled execution. Shares
    /// `run_create`'s structural validation via `validate_run_creation`; the
    /// only behavioral difference is the lease fields stamped onto the
    /// resulting `RunRecord`.
    pub fn run_liveness_create_leased_run(
        &self,
        input: LeasedRunCreateInput,
    ) -> KernelResult<RunRecord> {
        validate_id(&input.run_id, "invalid_run_id", "run id must not be empty")?;
        validate_id(
            &input.turn_id,
            "invalid_turn_id",
            "turn id must not be empty",
        )?;
        validate_id(
            &input.branch_id,
            "invalid_branch_id",
            "branch id must not be empty",
        )?;
        validate_steps(&input.steps)?;
        let mut state = self.lock_state()?;
        if state.runs.contains_key(&input.run_id) {
            return Err(duplicate("run_already_exists", "run already exists"));
        }
        validate_run_creation(
            &state,
            &input.branch_id,
            &input.turn_id,
            &input.schema_id,
            &input.start_turn_node_hash,
        )?;
        let now_ms = (self.now)();
        let fencing_token = generate_fencing_token(&mut state, &input.run_id, now_ms);
        let run = RunRecord {
            branch_id: input.branch_id,
            created_at_ms: now_ms,
            created_turn_nodes: Vec::new(),
            current_step_index: 0,
            execution_owner_id: Some(input.execution_owner_id),
            fencing_token: Some(fencing_token),
            lease_expires_at_ms: Some(input.lease_expires_at_ms),
            preemption_reason: None,
            run_id: input.run_id.clone(),
            schema_id: input.schema_id,
            start_turn_node_hash: input.start_turn_node_hash,
            status: RunStatus::Running,
            step_sequence: input.steps,
            turn_id: input.turn_id,
            updated_at_ms: now_ms,
        };
        state.runs.insert(input.run_id, run.clone());
        Ok(run)
    }

    /// KRT-BK010 (`kernel.run-liveness`): renews a run's execution lease.
    /// Requires the caller to present the current owner id and fencing token
    /// (rotated on every successful renewal) so a stale/preempted owner
    /// cannot silently keep extending a lease it no longer holds.
    pub fn run_liveness_renew_lease(
        &self,
        run_id: &str,
        execution_owner_id: &str,
        fencing_token: &str,
        next_lease_expires_at_ms: EpochMs,
    ) -> KernelResult<RunRecord> {
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
                "only running runs can renew their lease",
                None,
            ));
        }
        if run.execution_owner_id.is_none()
            && run.fencing_token.is_none()
            && run.lease_expires_at_ms.is_none()
        {
            return Err(KernelError::new(
                "run_lease_not_present",
                "run has no lease to renew",
                None,
            ));
        }
        let now_ms = (self.now)();
        if run
            .lease_expires_at_ms
            .is_some_and(|expiry| expiry <= now_ms)
        {
            return Err(KernelError::new(
                "run_lease_expired",
                "run lease has already expired",
                None,
            ));
        }
        if run.execution_owner_id.as_deref() != Some(execution_owner_id) {
            return Err(KernelError::new(
                "run_lease_owner_mismatch",
                "run lease owner does not match",
                None,
            ));
        }
        if run.fencing_token.as_deref() != Some(fencing_token) {
            return Err(KernelError::new(
                "run_lease_token_mismatch",
                "run lease fencing token is stale",
                None,
            ));
        }
        run.fencing_token = Some(generate_fencing_token(&mut state, run_id, now_ms));
        run.lease_expires_at_ms = Some(next_lease_expires_at_ms);
        run.updated_at_ms = now_ms;
        state.runs.insert(run_id.to_string(), run.clone());
        Ok(run)
    }

    /// KRT-BK010 (`kernel.run-liveness`): lists running runs whose lease has
    /// expired at or before `now_ms`. Leaseless running runs and paused runs
    /// are never included: a leaseless run has no `lease_expires_at_ms` to
    /// compare, and a paused run is an orderly, intentional state.
    pub fn run_liveness_list_expired(&self, now_ms: EpochMs) -> KernelResult<Vec<RunRecord>> {
        let state = self.lock_state()?;
        Ok(state
            .runs
            .values()
            .filter(|run| {
                run.status == RunStatus::Running
                    && run
                        .lease_expires_at_ms
                        .is_some_and(|expiry| expiry <= now_ms)
            })
            .cloned()
            .collect())
    }

    /// KRT-BK010 (`kernel.run-liveness`): preempts a run whose lease has
    /// expired, checkpointing any uncommitted staged work onto the run's
    /// active lineage exactly as a normal terminal completion would (so a
    /// preempted run's recovery state is coherent with the branch/turn head),
    /// then clears the lease and marks the run failed.
    pub fn run_liveness_preempt_expired(
        &self,
        run_id: &str,
        preempting_owner_id: &str,
        now_ms: EpochMs,
        reason: &str,
    ) -> KernelResult<RecoveryState> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let mut state = self.lock_state()?;
        let mut run = state
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| missing("run_not_found", "run does not exist"))?;
        if run.execution_owner_id.is_none()
            && run.fencing_token.is_none()
            && run.lease_expires_at_ms.is_none()
        {
            return Err(KernelError::new(
                "run_lease_not_present",
                "run has no lease to preempt",
                None,
            ));
        }
        if run.status != RunStatus::Running {
            return Err(KernelError::new(
                "run_not_running",
                "only running runs can be preempted",
                None,
            ));
        }
        if run.lease_expires_at_ms.is_none_or(|expiry| expiry > now_ms) {
            return Err(KernelError::new(
                "run_lease_not_expired",
                "run lease has not expired",
                None,
            ));
        }

        let event_blob =
            format!("tuvren.kernel.run-liveness.preempted:{run_id}:{preempting_owner_id}:{reason}")
                .into_bytes();
        let event_hash = hash_bytes_to_hex(&event_blob);
        state.objects.insert(
            event_hash.clone(),
            ObjectRecord {
                blob: event_blob,
                created_at_ms: now_ms,
            },
        );

        let staged_results = state
            .staged_results
            .get(run_id)
            .cloned()
            .unwrap_or_default();
        let prior_node = state
            .turn_nodes
            .get(&run_active_turn_node_hash(&run))
            .cloned()
            .ok_or_else(|| missing("turn_node_not_found", "run active turn node does not exist"))?;
        let next_tree_hash = if staged_results.is_empty() {
            prior_node.turn_tree_hash.clone()
        } else {
            incorporate_locked(
                &mut state,
                &prior_node.turn_tree_hash,
                &staged_results,
                now_ms,
            )?
        };
        let mut node = TurnNode {
            consumed_staged_results: staged_results,
            created_at_ms: now_ms,
            event_hash: Some(event_hash),
            hash: String::new(),
            previous_turn_node_hash: Some(prior_node.hash),
            schema_id: run.schema_id.clone(),
            turn_tree_hash: next_tree_hash,
        };
        node.hash = hash_turn_node_identity(&node)?;
        state.turn_nodes.insert(node.hash.clone(), node.clone());
        run.created_turn_nodes.push(node.hash.clone());
        set_run_head_refs(&mut state, &run, &node.hash)?;
        state.staged_results.remove(run_id);

        run.execution_owner_id = None;
        run.fencing_token = None;
        run.lease_expires_at_ms = None;
        run.preemption_reason = Some(reason.to_string());
        run.status = RunStatus::Failed;
        run.updated_at_ms = now_ms;
        state.runs.insert(run_id.to_string(), run.clone());
        state.run_signals.remove(run_id);

        let last_completed_step_id = run
            .current_step_index
            .checked_sub(1)
            .and_then(|index| run.step_sequence.get(index))
            .map(|step| step.id.clone());

        Ok(RecoveryState {
            consumed_staged_results: node.consumed_staged_results,
            last_completed_step_id,
            last_turn_node_hash: node.hash,
            step_sequence: run.step_sequence.clone(),
            uncommitted_staged_results: Vec::new(),
        })
    }

    /// ADR-034/KRT-BK010: fetches a run by id without altering its state.
    pub fn run_get(&self, run_id: &str) -> KernelResult<Option<RunRecord>> {
        validate_id(run_id, "invalid_run_id", "run id must not be empty")?;
        let state = self.lock_state()?;
        Ok(state.runs.get(run_id).cloned())
    }

    /// KRT-BK010 (`kernel.reclamation`): reachability-reclamation sweep. Ports
    /// `reclaimBackendState` (shared TS backend-invariant module) onto this
    /// backend's own maps; see the free functions below for the algorithm.
    pub fn maintenance_reclaim(&self) -> KernelResult<ReclamationSummary> {
        let now_ms = (self.now)();
        let mut state = self.lock_state()?;
        Ok(reclaim_state(&mut state, now_ms))
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
        let now_ms = (self.now)();
        for annotation in observe_results
            .iter()
            .flat_map(|observe_result| observe_result.annotations.iter())
        {
            let object_hash = hash_bytes_to_hex(annotation);
            state.objects.insert(
                object_hash,
                ObjectRecord {
                    blob: annotation.clone(),
                    created_at_ms: now_ms,
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
            run.updated_at_ms = now_ms;
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
            None => incorporate_locked(
                &mut state,
                &prior_node.turn_tree_hash,
                &staged_results,
                now_ms,
            )?,
        };
        let mut node = TurnNode {
            consumed_staged_results: staged_results,
            created_at_ms: now_ms,
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
        run.updated_at_ms = now_ms;
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
        let now_ms = (self.now)();
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
                incorporate_locked(
                    &mut state,
                    &prior_node.turn_tree_hash,
                    &staged_results,
                    now_ms,
                )?
            };
            let mut node = TurnNode {
                consumed_staged_results: staged_results,
                created_at_ms: now_ms,
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
        run.updated_at_ms = now_ms;
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
    now_ms: EpochMs,
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
            created_at_ms: now_ms,
            manifest,
            schema_id: schema.schema_id,
        },
    );
    Ok(tree_hash)
}

fn reactively_checkpoint_active_runs_on_branch(
    state: &mut KernelState,
    branch_id: &str,
    now_ms: EpochMs,
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
            incorporate_locked(state, &prior_node.turn_tree_hash, &staged_results, now_ms)?;
        let mut node = TurnNode {
            consumed_staged_results: staged_results,
            created_at_ms: now_ms,
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

/// Shared structural validation for `run_create` and
/// `run_liveness_create_leased_run`: the branch must exist and its head must
/// match the run's start node, the turn must exist and belong to the branch
/// with the start node inside its span, the schema must exist and match the
/// start node's schema, and the branch must not already have an active run.
fn validate_run_creation(
    state: &KernelState,
    branch_id: &str,
    turn_id: &str,
    schema_id: &str,
    start_turn_node_hash: &str,
) -> KernelResult<()> {
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
    if !is_ancestor(state, &turn.start_turn_node_hash, start_turn_node_hash)?
        || !is_ancestor(state, start_turn_node_hash, &turn.head_turn_node_hash)?
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
        run.branch_id == branch_id && matches!(run.status, RunStatus::Running | RunStatus::Paused)
    }) {
        return Err(KernelError::new(
            "branch_has_active_run",
            "branch already has a running or paused run",
            None,
        ));
    }
    Ok(())
}

/// KRT-BK010: generates a fresh, unique fencing token by hashing a
/// per-kernel monotonic counter together with the run id and the current
/// clock reading. This crate has no external randomness dependency, so a
/// counter-derived hash is used instead of a UUID.
fn generate_fencing_token(state: &mut KernelState, run_id: &str, now_ms: EpochMs) -> String {
    state.fencing_token_counter += 1;
    hash_bytes_to_hex(
        format!(
            "tuvren.kernel.fencing-token:{run_id}:{}:{now_ms}",
            state.fencing_token_counter
        )
        .as_bytes(),
    )
}

// KRT-BK010 (`kernel.reclamation`): a faithful port of the shared TypeScript
// `reclaimBackendState` reachability-reclamation algorithm
// (typescript/kernel/backends/shared/src/lib/backend-invariant-reclamation.ts)
// onto `KernelState`'s own maps. Two deliberate simplifications versus the TS
// original, both because the underlying structures are simpler here:
//   - No ordered-path-chunk closure: `StoredTurnTree.manifest` is already the
//     fully-resolved manifest, so `close_turn_tree_reachability` only needs to
//     walk manifest values, not a separate chunked-path record.
//   - No per-run "observe annotations" map to clean up: annotation objects
//     already live directly in `objects` via `run_complete_step`'s existing
//     annotation-storing loop, so sweeping a run only touches `runs`,
//     `staged_results`, and `run_signals`.

fn reclaim_state(state: &mut KernelState, now_ms: EpochMs) -> ReclamationSummary {
    let grace_horizon_ms = compute_grace_horizon_ms(state, now_ms);
    let keep = compute_keep_closure(state, grace_horizon_ms);
    let keep_turn_ids = collect_kept_turn_ids(state, &keep.turn_nodes);
    sweep(state, &keep, &keep_turn_ids, grace_horizon_ms)
}

/// The grace horizon is the `created_at_ms` of the oldest active execution
/// (running or paused run) — the conservative in-flight write horizon. No
/// durable state created at or after this instant is released. A leaseless
/// running run whose `updated_at_ms` has gone quiet for at least
/// `LEASELESS_RUN_EXPIRY_MS` is excluded from pinning this horizon
/// (KRT-BK002): it is treated as abandoned by a crashed/disconnected
/// creator. The run's own reachable lineage stays fully protected regardless,
/// via `seed_active_run_roots`'s unconditional `is_active_run(status)` check.
fn compute_grace_horizon_ms(state: &KernelState, now_ms: EpochMs) -> EpochMs {
    let mut grace_horizon_ms = EpochMs::MAX;
    for run in state.runs.values() {
        if is_active_run(&run.status)
            && !is_expired_leaseless_running_run(run, now_ms)
            && run.created_at_ms < grace_horizon_ms
        {
            grace_horizon_ms = run.created_at_ms;
        }
    }
    grace_horizon_ms
}

fn compute_keep_closure(state: &KernelState, grace_horizon_ms: EpochMs) -> KeepClosure {
    let mut keep = KeepClosure {
        objects: HashSet::new(),
        turn_nodes: HashSet::new(),
        turn_trees: HashSet::new(),
    };
    let mut turn_node_stack: Vec<HashString> = Vec::new();
    let mut turn_tree_stack: Vec<HashString> = Vec::new();

    seed_live_roots(state, &mut turn_node_stack, &mut keep);
    seed_grace_roots(
        state,
        grace_horizon_ms,
        &mut turn_node_stack,
        &mut turn_tree_stack,
        &mut keep,
    );
    close_turn_node_reachability(state, &mut keep, &mut turn_node_stack, &mut turn_tree_stack);
    close_turn_tree_reachability(state, &mut keep, &mut turn_tree_stack);

    keep
}

/// Live roots: non-archived branch heads, thread roots, active-run staged work.
fn seed_live_roots(
    state: &KernelState,
    turn_node_stack: &mut Vec<HashString>,
    keep: &mut KeepClosure,
) {
    for branch in state.branches.values() {
        if branch.archived_from_branch_id.is_none() {
            turn_node_stack.push(branch.head_turn_node_hash.clone());
        }
    }
    for thread in state.threads.values() {
        turn_node_stack.push(thread.root_turn_node_hash.clone());
    }
    seed_active_run_roots(state, turn_node_stack, keep);
}

/// Active-run roots: start/created turn nodes and staged results for running
/// or paused runs.
fn seed_active_run_roots(
    state: &KernelState,
    turn_node_stack: &mut Vec<HashString>,
    keep: &mut KeepClosure,
) {
    for run in state.runs.values() {
        if is_active_run(&run.status) {
            turn_node_stack.push(run.start_turn_node_hash.clone());
            for hash in &run.created_turn_nodes {
                turn_node_stack.push(hash.clone());
            }
        }
    }
    for (run_id, results) in &state.staged_results {
        if let Some(run) = state.runs.get(run_id)
            && is_active_run(&run.status)
        {
            for staged_result in results {
                keep.objects.insert(staged_result.object_hash.clone());
            }
        }
    }
}

/// Grace-window roots: any durable state newer than the oldest active
/// execution lease is retained, and its reference closure is retained with it.
fn seed_grace_roots(
    state: &KernelState,
    grace_horizon_ms: EpochMs,
    turn_node_stack: &mut Vec<HashString>,
    turn_tree_stack: &mut Vec<HashString>,
    keep: &mut KeepClosure,
) {
    for (hash, turn_node) in &state.turn_nodes {
        if turn_node.created_at_ms >= grace_horizon_ms {
            turn_node_stack.push(hash.clone());
        }
    }
    for (hash, turn_tree) in &state.turn_trees {
        if turn_tree.created_at_ms >= grace_horizon_ms {
            turn_tree_stack.push(hash.clone());
        }
    }
    for (hash, object) in &state.objects {
        if object.created_at_ms >= grace_horizon_ms {
            keep.objects.insert(hash.clone());
        }
    }
}

/// Closure over turn nodes (walk ancestors via `previous_turn_node_hash`).
fn close_turn_node_reachability(
    state: &KernelState,
    keep: &mut KeepClosure,
    turn_node_stack: &mut Vec<HashString>,
    turn_tree_stack: &mut Vec<HashString>,
) {
    while let Some(hash) = turn_node_stack.pop() {
        if keep.turn_nodes.contains(&hash) {
            continue;
        }
        let Some(turn_node) = state.turn_nodes.get(&hash) else {
            continue;
        };
        keep.turn_nodes.insert(hash.clone());
        if let Some(previous) = &turn_node.previous_turn_node_hash {
            turn_node_stack.push(previous.clone());
        }
        turn_tree_stack.push(turn_node.turn_tree_hash.clone());
        if let Some(event_hash) = &turn_node.event_hash {
            keep.objects.insert(event_hash.clone());
        }
        for staged_result in &turn_node.consumed_staged_results {
            keep.objects.insert(staged_result.object_hash.clone());
        }
    }
}

/// Closure over turn trees → manifest objects. No chunk handling: Rust's
/// `StoredTurnTree.manifest` has no separate ordered-path-chunk records.
fn close_turn_tree_reachability(
    state: &KernelState,
    keep: &mut KeepClosure,
    turn_tree_stack: &mut Vec<HashString>,
) {
    while let Some(hash) = turn_tree_stack.pop() {
        if keep.turn_trees.contains(&hash) {
            continue;
        }
        let Some(tree) = state.turn_trees.get(&hash) else {
            continue;
        };
        keep.turn_trees.insert(hash.clone());
        for value in tree.manifest.values() {
            match value {
                PathValue::Single(object_hash) => {
                    keep.objects.insert(object_hash.clone());
                }
                PathValue::Ordered(hashes) => {
                    for object_hash in hashes {
                        keep.objects.insert(object_hash.clone());
                    }
                }
                PathValue::Null => {}
            }
        }
    }
}

/// A turn is retained iff its head turn node is retained.
fn collect_kept_turn_ids(
    state: &KernelState,
    keep_turn_nodes: &HashSet<HashString>,
) -> HashSet<String> {
    state
        .turns
        .values()
        .filter(|turn| keep_turn_nodes.contains(&turn.head_turn_node_hash))
        .map(|turn| turn.turn_id.clone())
        .collect()
}

/// Releases every record outside the keep closure (and, for hash-addressed
/// content, older than the grace horizon). Deletion order is irrelevant.
fn sweep(
    state: &mut KernelState,
    keep: &KeepClosure,
    keep_turn_ids: &HashSet<String>,
    grace_horizon_ms: EpochMs,
) -> ReclamationSummary {
    ReclamationSummary {
        released_archived_branch_count: sweep_archived_branches(state, &keep.turn_nodes),
        released_object_count: sweep_objects(state, &keep.objects, grace_horizon_ms),
        released_run_count: sweep_runs(state, &keep.turn_nodes, keep_turn_ids),
        released_turn_count: sweep_turns(state, keep_turn_ids),
        released_turn_node_count: sweep_turn_nodes(state, &keep.turn_nodes, grace_horizon_ms),
        released_turn_tree_count: sweep_turn_trees(state, &keep.turn_trees, grace_horizon_ms),
        retained_object_count: state.objects.len(),
    }
}

fn sweep_runs(
    state: &mut KernelState,
    keep_turn_nodes: &HashSet<HashString>,
    keep_turn_ids: &HashSet<String>,
) -> usize {
    let run_ids: Vec<String> = state.runs.keys().cloned().collect();
    let mut released = 0;
    for run_id in run_ids {
        let retained = {
            let run = state.runs.get(&run_id).expect("run exists during sweep");
            let mut run_turn_node_hashes = vec![run.start_turn_node_hash.clone()];
            run_turn_node_hashes.extend(run.created_turn_nodes.iter().cloned());
            keep_turn_ids.contains(&run.turn_id)
                && run_turn_node_hashes
                    .iter()
                    .all(|hash| keep_turn_nodes.contains(hash))
        };
        if !retained {
            state.runs.remove(&run_id);
            state.staged_results.remove(&run_id);
            state.run_signals.remove(&run_id);
            released += 1;
        }
    }
    released
}

fn sweep_turns(state: &mut KernelState, keep_turn_ids: &HashSet<String>) -> usize {
    let turn_ids: Vec<String> = state.turns.keys().cloned().collect();
    let mut released = 0;
    for turn_id in turn_ids {
        if !keep_turn_ids.contains(&turn_id) {
            state.turns.remove(&turn_id);
            released += 1;
        }
    }
    released
}

/// Archived branches (`archived_from_branch_id.is_some()`) are swept when
/// their head turn node is not in the keep set. Non-archived (live, named)
/// branches are never swept regardless of reachability.
fn sweep_archived_branches(
    state: &mut KernelState,
    keep_turn_nodes: &HashSet<HashString>,
) -> usize {
    let branch_ids: Vec<String> = state.branches.keys().cloned().collect();
    let mut released = 0;
    for branch_id in branch_ids {
        let should_release = {
            let branch = state
                .branches
                .get(&branch_id)
                .expect("branch exists during sweep");
            branch.archived_from_branch_id.is_some()
                && !keep_turn_nodes.contains(&branch.head_turn_node_hash)
        };
        if should_release {
            state.branches.remove(&branch_id);
            released += 1;
        }
    }
    released
}

fn sweep_turn_nodes(
    state: &mut KernelState,
    keep_turn_nodes: &HashSet<HashString>,
    grace_horizon_ms: EpochMs,
) -> usize {
    let hashes: Vec<HashString> = state.turn_nodes.keys().cloned().collect();
    let mut released = 0;
    for hash in hashes {
        let should_release = {
            let node = state
                .turn_nodes
                .get(&hash)
                .expect("turn node exists during sweep");
            !keep_turn_nodes.contains(&hash) && node.created_at_ms < grace_horizon_ms
        };
        if should_release {
            state.turn_nodes.remove(&hash);
            released += 1;
        }
    }
    released
}

fn sweep_turn_trees(
    state: &mut KernelState,
    keep_turn_trees: &HashSet<HashString>,
    grace_horizon_ms: EpochMs,
) -> usize {
    let hashes: Vec<HashString> = state.turn_trees.keys().cloned().collect();
    let mut released = 0;
    for hash in hashes {
        let should_release = {
            let tree = state
                .turn_trees
                .get(&hash)
                .expect("turn tree exists during sweep");
            !keep_turn_trees.contains(&hash) && tree.created_at_ms < grace_horizon_ms
        };
        if should_release {
            state.turn_trees.remove(&hash);
            released += 1;
        }
    }
    released
}

fn sweep_objects(
    state: &mut KernelState,
    keep_objects: &HashSet<HashString>,
    grace_horizon_ms: EpochMs,
) -> usize {
    let hashes: Vec<HashString> = state.objects.keys().cloned().collect();
    let mut released = 0;
    for hash in hashes {
        let should_release = {
            let object = state
                .objects
                .get(&hash)
                .expect("object exists during sweep");
            !keep_objects.contains(&hash) && object.created_at_ms < grace_horizon_ms
        };
        if should_release {
            state.objects.remove(&hash);
            released += 1;
        }
    }
    released
}

fn is_active_run(status: &RunStatus) -> bool {
    matches!(status, RunStatus::Running | RunStatus::Paused)
}

/// A leaseless running run (no `execution_owner_id`/`fencing_token`/
/// `lease_expires_at_ms` at all) whose `updated_at_ms` has not advanced in at
/// least `LEASELESS_RUN_EXPIRY_MS` is treated as abandoned by a
/// crashed/disconnected creator. Judged on last-activity time
/// (`updated_at_ms`), not an explicit expiry field, since a leaseless run has
/// no such field. Only `Running` is eligible — `Paused` is an orderly,
/// intentional state and never auto-expires this way.
fn is_expired_leaseless_running_run(run: &RunRecord, now_ms: EpochMs) -> bool {
    run.status == RunStatus::Running
        && run.execution_owner_id.is_none()
        && run.fencing_token.is_none()
        && run.lease_expires_at_ms.is_none()
        && now_ms - run.updated_at_ms >= LEASELESS_RUN_EXPIRY_MS
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

    #[test]
    fn maintenance_reclaim_releases_unreachable_orphan_with_no_active_run() {
        let kernel = InMemoryKernel::new();
        let orphan_hash = kernel
            .store_put(b"orphan".to_vec(), None)
            .expect("store succeeds");

        let summary = kernel.maintenance_reclaim().expect("reclaim succeeds");

        assert!(
            !kernel
                .store_has(&orphan_hash)
                .expect("store lookup succeeds")
        );
        assert!(summary.released_object_count >= 1);
    }

    #[test]
    fn maintenance_reclaim_retains_object_reachable_from_live_branch_head() {
        let kernel = InMemoryKernel::new();
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        let created = kernel
            .thread_create("thread_a", "s1", "branch_a")
            .expect("thread_create");
        let root_node = kernel
            .node_get(&created.root_turn_node_hash)
            .expect("node_get")
            .expect("root node exists");
        let root_event_hash = root_node
            .event_hash
            .clone()
            .expect("root node has event hash");

        let summary = kernel.maintenance_reclaim().expect("reclaim succeeds");

        assert!(
            kernel
                .store_has(&root_event_hash)
                .expect("store lookup succeeds")
        );
        assert!(
            kernel
                .node_get(&created.root_turn_node_hash)
                .expect("node_get")
                .is_some()
        );
        assert_eq!(summary.released_object_count, 0);
    }

    #[test]
    fn leaseless_running_run_past_admin_expiry_does_not_pin_grace_horizon() {
        // Ticks consumed, in order: thread_create, run_create, store_put (orphan),
        // maintenance_reclaim.
        let kernel = kernel_with_clock(&[0, 0, 10, LEASELESS_RUN_EXPIRY_MS + 10]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        let thread = kernel
            .thread_create("thread_a", "s1", "branch_a")
            .expect("thread_create");
        let turn = kernel
            .turn_create(
                "turn_a",
                "thread_a",
                "branch_a",
                None,
                &thread.root_turn_node_hash,
            )
            .expect("turn_create");
        kernel
            .run_create(
                "run_a",
                &turn.turn_id,
                "branch_a",
                "s1",
                &thread.root_turn_node_hash,
                vec![StepDeclaration {
                    deterministic: true,
                    id: "work".to_string(),
                    metadata: None,
                    side_effects: false,
                }],
            )
            .expect("run_create");
        let orphan_hash = kernel
            .store_put(b"leaseless-expiry-orphan".to_vec(), None)
            .expect("store succeeds");

        kernel.maintenance_reclaim().expect("reclaim succeeds");

        assert!(
            !kernel
                .store_has(&orphan_hash)
                .expect("store lookup succeeds"),
            "a leaseless running run quiet past the admin expiry horizon must not pin reclamation"
        );
    }

    #[test]
    fn leaseless_running_run_within_admin_expiry_still_pins_grace_horizon() {
        // Ticks consumed, in order: thread_create, run_create, store_put (orphan),
        // maintenance_reclaim.
        let kernel = kernel_with_clock(&[0, 0, 10, 1_000]);
        kernel
            .schema_register(minimal_schema("s1"))
            .expect("schema_register");
        let thread = kernel
            .thread_create("thread_a", "s1", "branch_a")
            .expect("thread_create");
        let turn = kernel
            .turn_create(
                "turn_a",
                "thread_a",
                "branch_a",
                None,
                &thread.root_turn_node_hash,
            )
            .expect("turn_create");
        kernel
            .run_create(
                "run_a",
                &turn.turn_id,
                "branch_a",
                "s1",
                &thread.root_turn_node_hash,
                vec![StepDeclaration {
                    deterministic: true,
                    id: "work".to_string(),
                    metadata: None,
                    side_effects: false,
                }],
            )
            .expect("run_create");
        let orphan_hash = kernel
            .store_put(b"leaseless-active-orphan".to_vec(), None)
            .expect("store succeeds");

        kernel.maintenance_reclaim().expect("reclaim succeeds");

        assert!(
            kernel
                .store_has(&orphan_hash)
                .expect("store lookup succeeds"),
            "a leaseless running run still quiet within the admin expiry horizon must pin reclamation"
        );
    }

    #[test]
    fn expired_leaseless_running_run_truth_table() {
        fn run_with(
            status: RunStatus,
            execution_owner_id: Option<&str>,
            fencing_token: Option<&str>,
            lease_expires_at_ms: Option<EpochMs>,
            updated_at_ms: EpochMs,
        ) -> RunRecord {
            RunRecord {
                branch_id: "branch".to_string(),
                created_at_ms: 0,
                created_turn_nodes: Vec::new(),
                current_step_index: 0,
                execution_owner_id: execution_owner_id.map(str::to_string),
                fencing_token: fencing_token.map(str::to_string),
                lease_expires_at_ms,
                preemption_reason: None,
                run_id: "run".to_string(),
                schema_id: "schema".to_string(),
                start_turn_node_hash: "hash".to_string(),
                status,
                step_sequence: Vec::new(),
                turn_id: "turn".to_string(),
                updated_at_ms,
            }
        }

        // Leaseless (no owner/token/expiry) and quiet for >= the expiry horizon -> expired.
        let old_leaseless = run_with(RunStatus::Running, None, None, None, 0);
        assert!(is_expired_leaseless_running_run(
            &old_leaseless,
            LEASELESS_RUN_EXPIRY_MS
        ));

        // Leaseless but quiet for less than the expiry horizon -> not expired.
        let recent_leaseless = run_with(RunStatus::Running, None, None, None, 1);
        assert!(!is_expired_leaseless_running_run(
            &recent_leaseless,
            LEASELESS_RUN_EXPIRY_MS
        ));

        // Any lease field present at all -> never treated as an expired
        // leaseless run, regardless of how long it has been quiet.
        let leased_owner_only = run_with(RunStatus::Running, Some("owner"), None, None, 0);
        assert!(!is_expired_leaseless_running_run(
            &leased_owner_only,
            LEASELESS_RUN_EXPIRY_MS * 10
        ));

        let leased_token_only = run_with(RunStatus::Running, None, Some("token"), None, 0);
        assert!(!is_expired_leaseless_running_run(
            &leased_token_only,
            LEASELESS_RUN_EXPIRY_MS * 10
        ));

        let leased_expiry_only = run_with(RunStatus::Running, None, None, Some(1_000), 0);
        assert!(!is_expired_leaseless_running_run(
            &leased_expiry_only,
            LEASELESS_RUN_EXPIRY_MS * 10
        ));

        // Paused is an orderly state and never auto-expires this way, even if leaseless.
        let paused_leaseless = run_with(RunStatus::Paused, None, None, None, 0);
        assert!(!is_expired_leaseless_running_run(
            &paused_leaseless,
            LEASELESS_RUN_EXPIRY_MS * 10
        ));
    }
}
