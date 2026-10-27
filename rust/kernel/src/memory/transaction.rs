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
        #[cfg(feature = "conformance")]
        if let Some(operation) = &self.operation {
            operation.enter()?;
        }
        let mut state = self.lock_state()?;
        let snapshot = state.begin_journal();
        let working = Self {
            state: Arc::new(Mutex::new(std::mem::take(&mut *state))),
            in_transaction: true,
            ..self.clone()
        };
        let result = work(&working);
        let mut next = working.lock_state()?;
        #[cfg(not(feature = "conformance"))]
        let commit = result.is_ok();
        #[cfg(feature = "conformance")]
        let mut commit = false;
        #[cfg(feature = "conformance")]
        let result = result.and_then(|value| {
            #[cfg(feature = "conformance")]
            let fault = {
                let checkpoint = next.checkpoint_writes != snapshot.checkpoint_writes;
                let branch_id = _branch_id.or_else(|| {
                    _run_id
                        .filter(|_| checkpoint)
                        .and_then(|id| next.runs.get(id))
                        .map(|run| run.branch_id.as_str())
                });
                self.test_controls
                    .as_ref()
                    .map(|controls| controls.select_fault(branch_id, checkpoint))
                    .transpose()?
                    .flatten()
            };
            #[cfg(feature = "conformance")]
            if let Some(fault) = &fault
                && fault.point == crate::testkit::FaultPoint::BeforeCommit
            {
                return Err(fault.clone().into());
            }
            commit = true;
            #[cfg(feature = "conformance")]
            if let Some(fault) = fault {
                return Err(fault.into());
            }
            Ok(value)
        });
        next.finish_journal(snapshot, commit);
        *state = std::mem::take(&mut *next);
        result
    }
}
