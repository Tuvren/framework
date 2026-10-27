use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::{KernelError, KernelResult};

const SEAM: &str = "kernel.persistence.before-transact";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryReceipt {
    barrier_id: String,
    seam: String,
    operation_handle: String,
}

#[derive(Default)]
struct Barrier {
    participants: BTreeSet<String>,
    entries: BTreeMap<String, bool>,
    closed: bool,
}

#[derive(Default)]
struct State {
    barriers: BTreeMap<String, Barrier>,
    active: Option<String>,
    cancellations: BTreeMap<String, String>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Clone, Default)]
pub struct BarrierControl(Arc<Shared>);

#[derive(Clone)]
pub struct OperationContext {
    handle: String,
    participant: Option<String>,
    control: BarrierControl,
}

impl BarrierControl {
    pub fn operation(&self, handle: String, participant: Option<String>) -> OperationContext {
        OperationContext {
            handle,
            participant,
            control: self.clone(),
        }
    }

    pub fn arm(&self, id: &str, seam: &str, participants: &[String]) -> Result<(), String> {
        let distinct: BTreeSet<_> = participants.iter().cloned().collect();
        if id.is_empty()
            || seam != SEAM
            || participants.len() < 2
            || distinct.len() != participants.len()
            || participants.iter().any(String::is_empty)
        {
            return Err("unsupported barrier seam or participants".into());
        }
        let mut state = self.0.state.lock().map_err(|_| "barrier lock poisoned")?;
        if state.active.is_some() || state.barriers.contains_key(id) {
            return Err("barrier already armed".into());
        }
        state.barriers.insert(
            id.into(),
            Barrier {
                participants: distinct,
                entries: BTreeMap::new(),
                closed: false,
            },
        );
        state.active = Some(id.into());
        Ok(())
    }

    pub fn wait(&self, id: &str, handle: &str, timeout: Duration) -> Result<EntryReceipt, String> {
        if id.is_empty() || handle.is_empty() || timeout.is_zero() {
            return Err("invalid receipt request".into());
        }
        let state = self.0.state.lock().map_err(|_| "barrier lock poisoned")?;
        if !state.barriers.contains_key(id) {
            return Err("unknown barrier".into());
        }
        let (state, _) =
            self.0
                .changed
                .wait_timeout_while(state, timeout, |state| {
                    state.barriers.get(id).is_some_and(|barrier| {
                        !barrier.closed && !barrier.entries.contains_key(handle)
                    })
                })
                .map_err(|_| "barrier lock poisoned")?;
        if state
            .barriers
            .get(id)
            .is_some_and(|barrier| barrier.entries.contains_key(handle))
        {
            Ok(EntryReceipt {
                barrier_id: id.into(),
                seam: SEAM.into(),
                operation_handle: handle.into(),
            })
        } else if state.barriers.get(id).is_some_and(|barrier| barrier.closed) {
            Err("barrier closed before implementation entry receipt".into())
        } else {
            Err(format!("missing implementation entry receipt: {handle}"))
        }
    }

    pub fn release(&self, id: &str, handles: &[String]) -> Result<(), String> {
        if handles.is_empty() || handles.iter().any(String::is_empty) {
            return Err("release requires operation handles".into());
        }
        let mut state = self.0.state.lock().map_err(|_| "barrier lock poisoned")?;
        let barrier = state.barriers.get_mut(id).ok_or("unknown barrier")?;
        if handles
            .iter()
            .any(|handle| !barrier.entries.contains_key(handle))
        {
            return Err("release before implementation entry receipt".into());
        }
        for handle in handles {
            if let Some(released) = barrier.entries.get_mut(handle) {
                *released = true;
            }
        }
        if barrier.entries.len() == barrier.participants.len()
            && barrier.entries.values().all(|released| *released)
        {
            state.active = None;
        }
        self.0.changed.notify_all();
        Ok(())
    }

    pub fn close(&self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.active = None;
            for barrier in state.barriers.values_mut() {
                barrier.closed = true;
            }
            self.0.changed.notify_all();
        }
    }
}

impl OperationContext {
    pub fn cancel(&self, reason: &str) {
        if let Ok(mut state) = self.control.0.state.lock() {
            state
                .cancellations
                .entry(self.handle.clone())
                .or_insert_with(|| reason.into());
            self.control.0.changed.notify_all();
        }
    }

    pub fn cancellation(&self) -> Option<String> {
        self.control
            .0
            .state
            .lock()
            .ok()?
            .cancellations
            .get(&self.handle)
            .cloned()
    }

    pub(crate) fn enter(&self) -> KernelResult<()> {
        let shared = &self.control.0;
        let mut state = shared
            .state
            .lock()
            .map_err(|_| KernelError::new("Error", "barrier lock poisoned", None))?;
        let Some(id) = state.active.clone() else {
            return Ok(());
        };
        let Some(barrier) = state.barriers.get_mut(&id) else {
            return Ok(());
        };
        if !barrier
            .participants
            .contains(self.participant.as_deref().unwrap_or(&self.handle))
        {
            return Ok(());
        }
        barrier.entries.entry(self.handle.clone()).or_insert(false);
        shared.changed.notify_all();
        loop {
            if let Some(reason) = state.cancellations.get(&self.handle) {
                return Err(KernelError::new("Error", reason, None));
            }
            if state
                .barriers
                .get(&id)
                .is_some_and(|barrier| barrier.closed)
            {
                return Err(KernelError::new(
                    "Error",
                    "barrier closed before release",
                    None,
                ));
            }
            if state
                .barriers
                .get(&id)
                .and_then(|barrier| barrier.entries.get(&self.handle))
                .copied()
                .unwrap_or(false)
            {
                return Ok(());
            }
            state = shared
                .changed
                .wait(state)
                .map_err(|_| KernelError::new("Error", "barrier lock poisoned", None))?;
        }
    }
}
