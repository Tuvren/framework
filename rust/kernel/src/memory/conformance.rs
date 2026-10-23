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
