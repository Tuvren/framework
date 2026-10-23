use super::*;

impl InMemoryKernel {
    pub(super) fn read_transaction<T>(
        &self,
        _branch_id: Option<&str>,
        work: impl FnOnce(&Self) -> KernelResult<T>,
    ) -> KernelResult<T> {
        let reader = Self {
            in_transaction: true,
            ..self.clone()
        };
        let result = work(&reader)?;
        #[cfg(feature = "conformance")]
        if let Some(controls) = &self.test_controls
            && let Some(fault) = controls.select_fault(_branch_id, false)?
        {
            return Err(fault.into());
        }
        Ok(result)
    }

    pub(super) fn transaction<T>(
        &self,
        _branch_id: Option<&str>,
        _run_id: Option<&str>,
        work: impl FnOnce(&Self) -> KernelResult<T>,
    ) -> KernelResult<T> {
        let mut state = self.lock_state()?;
        let working = Self {
            state: Arc::new(Mutex::new(state.clone())),
            in_transaction: true,
            ..self.clone()
        };
        let result = work(&working)?;
        let mut next = working.lock_state()?;
        #[cfg(feature = "conformance")]
        let fault = {
            let branch_id = _branch_id.or_else(|| {
                _run_id
                    .filter(|_| next.checkpoint_writes != state.checkpoint_writes)
                    .and_then(|id| state.runs.get(id))
                    .map(|run| run.branch_id.as_str())
            });
            self.test_controls
                .as_ref()
                .map(|controls| {
                    controls
                        .select_fault(branch_id, next.checkpoint_writes != state.checkpoint_writes)
                })
                .transpose()?
                .flatten()
        };
        #[cfg(feature = "conformance")]
        if let Some(fault) = &fault
            && fault.point == crate::testkit::FaultPoint::BeforeCommit
        {
            return Err(fault.clone().into());
        }
        *state = std::mem::take(&mut *next);
        #[cfg(feature = "conformance")]
        if let Some(fault) = fault {
            return Err(fault.into());
        }
        Ok(result)
    }
}
