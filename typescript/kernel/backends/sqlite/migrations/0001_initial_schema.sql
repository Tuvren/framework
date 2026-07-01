CREATE TABLE objects (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE schemas (
  schema_id TEXT PRIMARY KEY,
  schema_cbor BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE turn_trees (
  hash TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL,
  manifest_cbor BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (schema_id) REFERENCES schemas(schema_id)
);
CREATE INDEX idx_turn_trees_schema_id ON turn_trees(schema_id);

CREATE TABLE turn_tree_paths (
  turn_tree_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  collection_kind TEXT NOT NULL,
  single_hash TEXT NULL,
  ordered_encoding TEXT NULL,
  ordered_count INTEGER NULL,
  ordered_inline_cbor BLOB NULL,
  ordered_chunk_list_cbor BLOB NULL,
  PRIMARY KEY (turn_tree_hash, path),
  FOREIGN KEY (turn_tree_hash) REFERENCES turn_trees(hash)
);
CREATE INDEX idx_turn_tree_paths_path_turn_tree_hash
  ON turn_tree_paths(path, turn_tree_hash);

CREATE TABLE ordered_path_chunks (
  chunk_hash TEXT PRIMARY KEY,
  item_count INTEGER NOT NULL,
  items_cbor BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE turn_nodes (
  hash TEXT PRIMARY KEY,
  previous_turn_node_hash TEXT NULL,
  turn_tree_hash TEXT NOT NULL,
  consumed_staged_results_cbor BLOB NOT NULL,
  schema_id TEXT NOT NULL,
  event_hash TEXT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (previous_turn_node_hash) REFERENCES turn_nodes(hash),
  FOREIGN KEY (turn_tree_hash) REFERENCES turn_trees(hash),
  FOREIGN KEY (schema_id) REFERENCES schemas(schema_id),
  FOREIGN KEY (event_hash) REFERENCES objects(hash)
);
CREATE INDEX idx_turn_nodes_previous_turn_node_hash
  ON turn_nodes(previous_turn_node_hash);
CREATE INDEX idx_turn_nodes_turn_tree_hash ON turn_nodes(turn_tree_hash);

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  schema_id TEXT NOT NULL,
  root_turn_node_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (schema_id) REFERENCES schemas(schema_id),
  FOREIGN KEY (root_turn_node_hash) REFERENCES turn_nodes(hash)
);

CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  head_turn_node_hash TEXT NOT NULL,
  archived_from_branch_id TEXT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id),
  FOREIGN KEY (head_turn_node_hash) REFERENCES turn_nodes(hash),
  FOREIGN KEY (archived_from_branch_id) REFERENCES branches(branch_id)
);
CREATE INDEX idx_branches_thread_id ON branches(thread_id);
CREATE INDEX idx_branches_head_turn_node_hash ON branches(head_turn_node_hash);

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_turn_id TEXT NULL,
  start_turn_node_hash TEXT NOT NULL,
  head_turn_node_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id),
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  FOREIGN KEY (parent_turn_id) REFERENCES turns(turn_id),
  FOREIGN KEY (start_turn_node_hash) REFERENCES turn_nodes(hash),
  FOREIGN KEY (head_turn_node_hash) REFERENCES turn_nodes(hash)
);
CREATE INDEX idx_turns_thread_id ON turns(thread_id);
CREATE INDEX idx_turns_branch_id ON turns(branch_id);
CREATE INDEX idx_turns_parent_turn_id ON turns(parent_turn_id);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  start_turn_node_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step_index INTEGER NOT NULL,
  step_sequence_cbor BLOB NOT NULL,
  created_turn_nodes_cbor BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turns(turn_id),
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  FOREIGN KEY (schema_id) REFERENCES schemas(schema_id),
  FOREIGN KEY (start_turn_node_hash) REFERENCES turn_nodes(hash)
);
CREATE INDEX idx_runs_turn_id ON runs(turn_id);
CREATE INDEX idx_runs_branch_id ON runs(branch_id);
CREATE INDEX idx_runs_branch_id_status ON runs(branch_id, status);

CREATE TABLE staged_results (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  object_hash TEXT NOT NULL,
  object_type TEXT NOT NULL,
  status TEXT NOT NULL,
  interrupt_payload_cbor BLOB NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (object_hash) REFERENCES objects(hash)
);
CREATE INDEX idx_staged_results_run_id_status ON staged_results(run_id, status);
CREATE INDEX idx_staged_results_object_hash ON staged_results(object_hash);
