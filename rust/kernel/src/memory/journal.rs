use std::collections::HashMap;
use std::ops::Deref;

use super::KernelState;

#[derive(Clone)]
pub(super) struct JournalMap<V> {
    values: HashMap<String, V>,
    undo: Option<Vec<(String, Option<V>)>>,
}

impl<V> Default for JournalMap<V> {
    fn default() -> Self {
        Self {
            values: HashMap::new(),
            undo: None,
        }
    }
}

// Read access cannot bypass the journal with an untracked mutable reference.
impl<V> Deref for JournalMap<V> {
    type Target = HashMap<String, V>;

    fn deref(&self) -> &Self::Target {
        &self.values
    }
}

impl<V: Clone> JournalMap<V> {
    fn remember(&mut self, key: &str) {
        if let Some(undo) = &mut self.undo {
            undo.push((key.to_string(), self.values.get(key).cloned()));
        }
    }

    pub(super) fn insert(&mut self, key: String, value: V) {
        self.remember(&key);
        self.values.insert(key, value);
    }

    pub(super) fn remove(&mut self, key: &str) -> Option<V> {
        if self.values.contains_key(key) {
            self.remember(key);
        }
        self.values.remove(key)
    }

    pub(super) fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        if self.values.contains_key(key) {
            self.remember(key);
        }
        self.values.get_mut(key)
    }

    pub(super) fn get_or_insert_default(&mut self, key: String) -> &mut V
    where
        V: Default,
    {
        self.remember(&key);
        self.values.entry(key).or_default()
    }

    fn begin(&mut self) {
        self.undo = Some(Vec::new());
    }

    fn finish(&mut self, commit: bool) -> usize {
        let undo = self.undo.take().expect("write transaction started journal");
        let count = undo.len();
        if !commit {
            for (key, prior) in undo.into_iter().rev() {
                match prior {
                    Some(value) => {
                        self.values.insert(key, value);
                    }
                    None => {
                        self.values.remove(&key);
                    }
                }
            }
        }
        count
    }
}

pub(super) struct Snapshot {
    archive_counter: u64,
    fencing_token_counter: u64,
    turn_order_len: usize,
    #[cfg(feature = "conformance")]
    pub(super) checkpoint_writes: u64,
}

impl KernelState {
    pub(super) fn begin_journal(&mut self) -> Snapshot {
        self.branches.begin();
        self.objects.begin();
        self.runs.begin();
        self.run_signals.begin();
        self.schemas.begin();
        self.staged_results.begin();
        self.threads.begin();
        self.thread_created_at.begin();
        self.turn_nodes.begin();
        self.turns.begin();
        self.turn_trees.begin();
        Snapshot {
            archive_counter: self.archive_counter,
            fencing_token_counter: self.fencing_token_counter,
            turn_order_len: self.turn_order.len(),
            #[cfg(feature = "conformance")]
            checkpoint_writes: self.checkpoint_writes,
        }
    }

    pub(super) fn finish_journal(&mut self, snapshot: Snapshot, commit: bool) {
        let _entries = self.branches.finish(commit)
            + self.objects.finish(commit)
            + self.runs.finish(commit)
            + self.run_signals.finish(commit)
            + self.schemas.finish(commit)
            + self.staged_results.finish(commit)
            + self.threads.finish(commit)
            + self.thread_created_at.finish(commit)
            + self.turn_nodes.finish(commit)
            + self.turns.finish(commit)
            + self.turn_trees.finish(commit);
        #[cfg(feature = "conformance")]
        {
            self.journal_entry_count += u64::try_from(_entries).expect("journal fits u64");
        }
        if !commit {
            self.archive_counter = snapshot.archive_counter;
            self.fencing_token_counter = snapshot.fencing_token_counter;
            self.turn_order.truncate(snapshot.turn_order_len);
            #[cfg(feature = "conformance")]
            {
                self.checkpoint_writes = snapshot.checkpoint_writes;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_restores_repeated_updates_insertions_and_removals() {
        let mut map = JournalMap::default();
        map.insert("existing".into(), vec![1]);
        map.insert("removed".into(), vec![2]);
        map.begin();
        map.insert("existing".into(), vec![3]);
        map.get_mut("existing").unwrap().push(4);
        assert_eq!(map.remove("existing"), Some(vec![3, 4]));
        map.insert("existing".into(), vec![5]);
        map.get_or_insert_default("new".into()).push(6);
        assert_eq!(map.remove("removed"), Some(vec![2]));
        assert!(map.remove("missing").is_none());
        assert!(map.get_mut("missing").is_none());
        assert_eq!(map.finish(false), 6);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("existing"), Some(&vec![1]));
        assert_eq!(map.get("removed"), Some(&vec![2]));
        map.begin();
        map.insert("committed".into(), vec![7]);
        assert_eq!(map.finish(true), 1);
        assert_eq!(map.get("committed"), Some(&vec![7]));
    }

    #[test]
    fn rollback_restores_counters_and_truncates_only_appended_turn_order() {
        let mut state = KernelState::default();
        state.turn_order.push("prior".into());
        let snapshot = state.begin_journal();
        state.archive_counter += 1;
        state.fencing_token_counter += 1;
        state.turn_order.push("rolled-back".into());
        #[cfg(feature = "conformance")]
        {
            state.checkpoint_writes += 1;
        }
        state.finish_journal(snapshot, false);
        assert_eq!(state.archive_counter, 0);
        assert_eq!(state.fencing_token_counter, 0);
        assert_eq!(state.turn_order, ["prior"]);
        #[cfg(feature = "conformance")]
        assert_eq!(state.checkpoint_writes, 0);
    }
}
