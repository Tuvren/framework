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
    turn_nodes: HashMap<HashString, TurnNode>,
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
        state.threads.insert(
            thread_id.to_string(),
            ThreadRecord {
                root_turn_node_hash: root_node.hash.clone(),
                schema_id: schema_id.to_string(),
                thread_id: thread_id.to_string(),
            },
        );
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

    pub fn thread_get(&self, thread_id: &str) -> KernelResult<Option<ThreadRecord>> {
        let state = self.lock_state()?;
        Ok(state.threads.get(thread_id).cloned())
    }

    pub fn branch_create(
        &self,
        branch_id: &str,
        thread_id: &str,
        from_turn_node_hash: &str,
    ) -> KernelResult<BranchRecord> {
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
        let state = self.lock_state()?;
        Ok(state.branches.get(branch_id).cloned())
    }

    pub fn branch_set_head(
        &self,
        branch_id: &str,
        turn_node_hash: &str,
    ) -> KernelResult<SetHeadResult> {
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
        let candidate_parent_turns = state
            .turns
            .values()
            .filter(|turn| {
                turn.thread_id == thread_id && turn.head_turn_node_hash == start_turn_node_hash
            })
            .collect::<Vec<_>>();
        if parent_turn_id.is_none() && !candidate_parent_turns.is_empty() {
            return Err(KernelError::new(
                "turn_parent_required",
                "turn parent must reference the previous semantic turn when one exists",
                None,
            ));
        }
        if let Some(parent_turn_id) = &parent_turn_id {
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
        Ok(turn)
    }

    pub fn turn_get(&self, turn_id: &str) -> KernelResult<Option<TurnRecord>> {
        let state = self.lock_state()?;
        Ok(state.turns.get(turn_id).cloned())
    }

    pub fn turn_update_head(&self, turn_id: &str, head_turn_node_hash: &str) -> KernelResult<()> {
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
        let mut modify = None;
        let mut retry = None;
        for verdict in verdicts {
            match verdict {
                Verdict::Abort { .. } if abort.is_none() => abort = Some(verdict),
                Verdict::Pause { .. } if pause.is_none() => pause = Some(verdict),
                Verdict::Modify { .. } if modify.is_none() => modify = Some(verdict),
                Verdict::Retry { .. } if retry.is_none() => retry = Some(verdict),
                _ => {}
            }
        }
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
