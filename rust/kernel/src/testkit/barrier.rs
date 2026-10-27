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
struct Entry {
    released: bool,
    acquired: bool,
    finished: bool,
}

#[derive(Default)]
struct Barrier {
    participants: BTreeSet<String>,
    entries: BTreeMap<String, Entry>,
    last_released: Option<String>,
    closed: bool,
}

#[derive(Default)]
struct State {
    barriers: BTreeMap<String, Barrier>,
    active: Option<String>,
    cancellations: BTreeMap<String, String>,
    interruptions: BTreeMap<String, String>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    release_order: Mutex<()>,
    changed: Condvar,
}

#[derive(Clone, Default)]
pub struct BarrierControl(Arc<Shared>);

#[derive(Clone)]
pub struct OperationContext {
    handle: String,
    control: BarrierControl,
}

impl BarrierControl {
    pub fn operation(&self, handle: String) -> OperationContext {
        OperationContext {
            handle,
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
                last_released: None,
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
        let _order = self
            .0
            .release_order
            .lock()
            .map_err(|_| "barrier release lock poisoned")?;
        let mut state = self.0.state.lock().map_err(|_| "barrier lock poisoned")?;
        let barrier = state.barriers.get(id).ok_or("unknown barrier")?;
        if handles
            .iter()
            .any(|handle| !barrier.entries.contains_key(handle))
        {
            return Err("release before implementation entry receipt".into());
        }
        for handle in handles {
            state = self
                .0
                .changed
                .wait_while(state, |state| {
                    state.barriers.get(id).is_some_and(|barrier| {
                        !barrier.closed
                            && barrier.last_released.as_ref().is_some_and(|previous| {
                                barrier
                                    .entries
                                    .get(previous)
                                    .is_some_and(|entry| !entry.acquired && !entry.finished)
                            })
                    })
                })
                .map_err(|_| "barrier lock poisoned")?;
            let barrier = state.barriers.get_mut(id).ok_or("unknown barrier")?;
            if barrier.closed {
                return Err("barrier closed before release".into());
            }
            if let Some(entry) = barrier.entries.get_mut(handle) {
                entry.released = true;
            }
            barrier.last_released = Some(handle.clone());
            self.0.changed.notify_all();
        }
        let barrier = state.barriers.get(id).ok_or("unknown barrier")?;
        if barrier.entries.len() >= barrier.participants.len()
            && barrier.entries.values().all(|entry| entry.released)
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

    pub fn interruption(&self) -> Option<String> {
        self.control
            .0
            .state
            .lock()
            .ok()?
            .interruptions
            .get(&self.handle)
            .cloned()
    }

    pub(crate) fn acquired(&self) {
        self.finish_entry(true);
    }

    pub(crate) fn abandoned(&self) {
        self.finish_entry(false);
    }

    fn finish_entry(&self, acquired: bool) {
        if let Ok(mut state) = self.control.0.state.lock() {
            for barrier in state.barriers.values_mut() {
                if let Some(entry) = barrier.entries.get_mut(&self.handle) {
                    entry.acquired |= acquired;
                    entry.finished |= !acquired;
                }
            }
            self.control.0.changed.notify_all();
        }
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
        barrier.entries.entry(self.handle.clone()).or_default();
        shared.changed.notify_all();
        loop {
            let reason = state.cancellations.get(&self.handle).cloned().or_else(|| {
                state
                    .barriers
                    .get(&id)
                    .is_some_and(|barrier| barrier.closed)
                    .then(|| "barrier closed before release".to_string())
            });
            if let Some(reason) = reason {
                state
                    .interruptions
                    .insert(self.handle.clone(), reason.clone());
                if let Some(entry) = state
                    .barriers
                    .get_mut(&id)
                    .and_then(|barrier| barrier.entries.get_mut(&self.handle))
                {
                    entry.finished = true;
                }
                shared.changed.notify_all();
                return Err(KernelError::new("Error", &reason, None));
            }
            if state
                .barriers
                .get(&id)
                .and_then(|barrier| barrier.entries.get(&self.handle))
                .is_some_and(|entry| entry.released)
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
