use super::*;
use crate::testkit::{FaultPoint, KernelTestControls};

impl InMemoryKernel {
    pub fn with_test_controls(controls: KernelTestControls) -> KernelResult<Self> {
        controls.require_clocks()?;
        let backend = controls.clone();
        let worker = controls.clone();
        Ok(Self {
            state: Arc::new(Mutex::new(KernelState::default())),
            now: Arc::new(move || backend.backend_now()),
            worker_clock: Some(Arc::new(move || worker.worker_now())),
            mutant: controls.mutant.clone(),
            test_controls: Some(controls),
        })
    }

    pub(super) fn test_transaction<T>(
        &self,
        branch_id: Option<&str>,
        run_id: Option<&str>,
        work: impl FnOnce(&Self) -> KernelResult<T>,
    ) -> KernelResult<T> {
        let mut state = self.lock_state()?;
        let branch_id = branch_id.or_else(|| {
            run_id
                .and_then(|id| state.runs.get(id))
                .map(|run| run.branch_id.as_str())
        });
        let working = Self {
            state: Arc::new(Mutex::new(state.clone())),
            now: Arc::clone(&self.now),
            worker_clock: self.worker_clock.clone(),
            test_controls: None,
            mutant: self.mutant.clone(),
        };
        let result = work(&working)?;
        let next = working.lock_state()?;
        let checkpoint = next.checkpoint_writes != state.checkpoint_writes;
        let fault = self
            .test_controls
            .as_ref()
            .ok_or_else(|| {
                KernelError::new(
                    "kernel_test_controls_required",
                    "test transaction requires controls",
                    None,
                )
            })?
            .select_fault(branch_id, checkpoint)?;
        if let Some(fault) = &fault
            && fault.point == FaultPoint::BeforeCommit
        {
            return Err(fault.clone().into());
        }
        *state = next.clone();
        if let Some(fault) = fault {
            return Err(fault.into());
        }
        Ok(result)
    }
}

pub(super) fn reclaim_with_reachable_delete(
    state: &mut KernelState,
    now_ms: EpochMs,
    mutant: &crate::testkit::mutants::KernelMutant,
) -> ReclamationSummary {
    let mut candidates = HashSet::new();
    for branch in state
        .branches
        .values()
        .filter(|branch| branch.archived_from_branch_id.is_some())
    {
        let mut current = Some(branch.head_turn_node_hash.as_str());
        let mut visited = HashSet::new();
        while let Some(hash) = current {
            if !visited.insert(hash) {
                break;
            }
            let Some(node) = state.turn_nodes.get(hash) else {
                break;
            };
            candidates.extend(
                node.consumed_staged_results
                    .iter()
                    .map(|result| result.object_hash.clone()),
            );
            current = node.previous_turn_node_hash.as_deref();
        }
    }
    let mut summary = reclaim_state(state, now_ms);
    for hash in candidates {
        if state.objects.remove(&hash).is_some() {
            mutant.activate();
            summary.released_object_count += 1;
            summary.retained_object_count -= 1;
        }
    }
    summary
}
