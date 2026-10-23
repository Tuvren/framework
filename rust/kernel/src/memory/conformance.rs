use super::*;
use crate::testkit::KernelTestControls;

impl InMemoryKernel {
    pub fn with_test_controls(controls: KernelTestControls) -> KernelResult<Self> {
        controls.require_clocks()?;
        let backend = controls.clone();
        let worker = controls.clone();
        Ok(Self {
            state: Arc::new(Mutex::new(KernelState::default())),
            in_transaction: false,
            now: Arc::new(move || backend.backend_now()),
            worker_clock: Some(Arc::new(move || worker.worker_now())),
            mutant: controls.mutant.clone(),
            test_controls: Some(controls),
        })
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
        let Some(source) = branch
            .archived_from_branch_id
            .as_ref()
            .and_then(|id| state.branches.get(id))
        else {
            continue;
        };
        let live = branch_lineage(state, &source.head_turn_node_hash);
        let mut current = Some(branch.head_turn_node_hash.as_str());
        let mut visited = HashSet::new();
        while let Some(hash) = current {
            if !visited.insert(hash) {
                break;
            }
            let Some(node) = state.turn_nodes.get(hash) else {
                break;
            };
            if live.contains(hash) {
                candidates.extend(
                    node.consumed_staged_results
                        .iter()
                        .map(|result| result.object_hash.clone()),
                );
                break;
            }
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

fn branch_lineage<'a>(state: &'a KernelState, head: &'a str) -> HashSet<&'a str> {
    let mut lineage = HashSet::new();
    let mut current = Some(head);
    while let Some(hash) = current {
        if !lineage.insert(hash) {
            break;
        }
        current = state
            .turn_nodes
            .get(hash)
            .and_then(|node| node.previous_turn_node_hash.as_deref());
    }
    lineage
}
