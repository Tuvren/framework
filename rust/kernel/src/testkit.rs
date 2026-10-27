use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicI64, Ordering},
};

use serde::{Deserialize, Deserializer};

use crate::{EpochMs, KernelError, KernelRecord, KernelResult};

pub mod barrier;
pub mod mutants;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FaultPoint {
    BeforeCommit,
    AfterTurnNodeWriteBeforeHead,
    AfterHeadMoveBeforeStagingClear,
    AfterCommitBeforeAck,
    CommitOutcomeUnknown,
}
impl FaultPoint {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BeforeCommit => "before-commit",
            Self::AfterTurnNodeWriteBeforeHead => "after-turn-node-write-before-head",
            Self::AfterHeadMoveBeforeStagingClear => "after-head-move-before-staging-clear",
            Self::AfterCommitBeforeAck => "after-commit-before-ack",
            Self::CommitOutcomeUnknown => "commit-outcome-unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FaultMode {
    Throw,
    Block,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FaultOperation {
    Checkpoint,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FaultSelector {
    #[serde(default, deserialize_with = "present")]
    pub branch_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub operation: Option<FaultOperation>,
}

fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FaultRequest {
    pub point: FaultPoint,
    pub selector: FaultSelector,
    pub occurrence: u64,
    pub mode: FaultMode,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InjectedFault {
    pub token: String,
    pub point: FaultPoint,
}
impl From<InjectedFault> for KernelError {
    fn from(fault: InjectedFault) -> Self {
        Self::new(
            "kernel_persistence_fault_injected",
            "injected persistence fault interrupted verification",
            Some(KernelRecord::Map(BTreeMap::from([
                ("token".into(), KernelRecord::Text(fault.token)),
                (
                    "point".into(),
                    KernelRecord::Text(fault.point.as_str().into()),
                ),
            ]))),
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClockDomain {
    Backend,
    Worker,
}

#[derive(Debug)]
struct ArmedFault {
    request: FaultRequest,
    token: String,
    matches: u64,
}
#[derive(Debug, Default)]
struct FaultState {
    arming_count: u64,
    armed: Option<ArmedFault>,
}

#[derive(Clone, Debug)]
pub struct KernelTestControls {
    pub(crate) mutant: Option<mutants::KernelMutant>,
    backend_clock: Arc<OnceLock<AtomicI64>>,
    worker_clock: Arc<OnceLock<AtomicI64>>,
    faults: Arc<Mutex<FaultState>>,
}
impl Default for KernelTestControls {
    fn default() -> Self {
        Self {
            mutant: None,
            backend_clock: Arc::new(OnceLock::new()),
            worker_clock: Arc::new(OnceLock::new()),
            faults: Arc::new(Mutex::new(FaultState::default())),
        }
    }
}
impl KernelTestControls {
    pub fn with_mutant(mutant: Option<mutants::KernelMutant>) -> Self {
        Self {
            mutant,
            ..Self::default()
        }
    }

    pub fn set_clock(&self, domain: ClockDomain, now_ms: EpochMs) -> KernelResult<()> {
        if !u64::try_from(now_ms).is_ok_and(|n| n <= MAX_SAFE_INTEGER) {
            return Err(KernelError::new(
                "kernel_test_clock_invalid",
                "clock requires a nonnegative safe integer",
                None,
            ));
        }
        match domain {
            ClockDomain::Backend => &self.backend_clock,
            ClockDomain::Worker => &self.worker_clock,
        }
        .get_or_init(|| AtomicI64::new(now_ms))
        .store(now_ms, Ordering::SeqCst);
        Ok(())
    }

    pub fn arm_fault(&self, request: FaultRequest) -> KernelResult<String> {
        if !matches!(
            request.point,
            FaultPoint::BeforeCommit | FaultPoint::AfterCommitBeforeAck
        ) || request.mode == FaultMode::Block
        {
            return Err(KernelError::new(
                "kernel_fault_point_unsupported",
                "storage boundary or fault mode unsupported by the in-memory backend",
                Some(KernelRecord::Map(BTreeMap::from([
                    (
                        "point".into(),
                        KernelRecord::Text(request.point.as_str().into()),
                    ),
                    (
                        "mode".into(),
                        KernelRecord::Text(
                            match request.mode {
                                FaultMode::Throw => "throw",
                                FaultMode::Block => "block",
                            }
                            .into(),
                        ),
                    ),
                ]))),
            ));
        }
        if request.occurrence == 0 || request.occurrence > MAX_SAFE_INTEGER {
            return Err(KernelError::new(
                "kernel_test_fault_invalid",
                "fault occurrence requires a positive safe integer",
                None,
            ));
        }
        let mut state = self.faults.lock().map_err(|_| poisoned())?;
        state.arming_count += 1;
        let token = format!("fault-{}", state.arming_count);
        state.armed = Some(ArmedFault {
            request,
            token: token.clone(),
            matches: 0,
        });
        Ok(token)
    }

    pub(crate) fn require_clocks(&self) -> KernelResult<()> {
        if self.backend_clock.get().is_none() || self.worker_clock.get().is_none() {
            return Err(KernelError::new(
                "kernel_test_clock_required",
                "setClock required for backend and worker domains before initialization",
                None,
            ));
        }
        Ok(())
    }
    pub(crate) fn backend_now(&self) -> EpochMs {
        self.backend_clock
            .get()
            .expect("backend clock configured before kernel initialization")
            .load(Ordering::SeqCst)
    }
    pub(crate) fn worker_now(&self) -> EpochMs {
        self.worker_clock
            .get()
            .expect("worker clock configured before kernel initialization")
            .load(Ordering::SeqCst)
    }

    pub(crate) fn select_fault(
        &self,
        branch_id: Option<&str>,
        checkpoint: bool,
    ) -> KernelResult<Option<InjectedFault>> {
        let mut state = self.faults.lock().map_err(|_| poisoned())?;
        let Some(armed) = &mut state.armed else {
            return Ok(None);
        };
        if armed
            .request
            .selector
            .branch_id
            .as_deref()
            .is_some_and(|selected| Some(selected) != branch_id)
            || (armed.request.selector.operation.is_some() && !checkpoint)
        {
            return Ok(None);
        }
        armed.matches += 1;
        if armed.matches < armed.request.occurrence {
            return Ok(None);
        }
        let fault = InjectedFault {
            token: armed.token.clone(),
            point: armed.request.point,
        };
        state.armed = None;
        Ok(Some(fault))
    }
}

fn poisoned() -> KernelError {
    KernelError::new(
        "kernel_test_controls_poisoned",
        "test controls lock poisoned",
        None,
    )
}
