use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use crate::{KernelError, KernelResult};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutantKind {
    WrongOpaqueObjectHash,
    DropUncommittedStagedResultOnRecovery,
    DeleteObjectReachableThroughLiveRoot,
}

impl MutantKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::WrongOpaqueObjectHash => "kernel.wrong-opaque-object-hash",
            Self::DropUncommittedStagedResultOnRecovery => {
                "kernel.drop-uncommitted-staged-result-on-recovery"
            }
            Self::DeleteObjectReachableThroughLiveRoot => {
                "kernel.delete-object-reachable-through-live-root"
            }
        }
    }

    pub fn signal(self) -> &'static str {
        match self {
            Self::WrongOpaqueObjectHash => "mutant.wrong-opaque-object-hash.entered",
            Self::DropUncommittedStagedResultOnRecovery => {
                "mutant.drop-uncommitted-staged-result-on-recovery.entered"
            }
            Self::DeleteObjectReachableThroughLiveRoot => {
                "mutant.delete-object-reachable-through-live-root.entered"
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct KernelMutant {
    kind: MutantKind,
    activations: Arc<AtomicU64>,
}

impl KernelMutant {
    pub fn select(id: &str) -> KernelResult<Self> {
        let kind = [
            MutantKind::WrongOpaqueObjectHash,
            MutantKind::DropUncommittedStagedResultOnRecovery,
            MutantKind::DeleteObjectReachableThroughLiveRoot,
        ]
        .into_iter()
        .find(|kind| kind.id() == id)
        .ok_or_else(|| {
            KernelError::new("kernel_mutant_unknown", "unknown Rust kernel mutant", None)
        })?;
        Ok(Self {
            kind,
            activations: Arc::new(AtomicU64::new(0)),
        })
    }

    pub fn kind(&self) -> MutantKind {
        self.kind
    }
    pub fn activation_count(&self) -> u64 {
        self.activations.load(Ordering::SeqCst)
    }
    pub(crate) fn activate(&self) {
        self.activations.fetch_add(1, Ordering::SeqCst);
    }
}
