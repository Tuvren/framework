-- Relational row-per-record schema for @tuvren/backend-postgres (issue #110 / ADR-067).
-- Mirrors the post-#108 SQLite family shape (migrations 0001–0006 consolidated), with:
--   * scope TEXT on every table for ADR-048/049 row-level isolation in a shared schema
--   * BYTEA / BIGINT for Postgres types
--   * DEFERRABLE INITIALLY DEFERRED foreign keys (SQLite reclaim's defer_foreign_keys equivalent)
--   * COLLATE "C" on every TEXT column so ordering and range comparisons are
--     byte-wise, matching SQLite's BINARY collation instead of the database's
--     locale-dependent default (keeps ORDER BY / keyset pagination results
--     identical across backends and deployments)

CREATE TABLE objects (
  scope TEXT COLLATE "C" NOT NULL,
  hash TEXT COLLATE "C" NOT NULL,
  media_type TEXT COLLATE "C" NOT NULL,
  bytes BYTEA NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, hash)
);

CREATE TABLE schemas (
  scope TEXT COLLATE "C" NOT NULL,
  schema_id TEXT COLLATE "C" NOT NULL,
  schema_cbor BYTEA NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, schema_id)
);

CREATE TABLE turn_trees (
  scope TEXT COLLATE "C" NOT NULL,
  hash TEXT COLLATE "C" NOT NULL,
  schema_id TEXT COLLATE "C" NOT NULL,
  manifest_cbor BYTEA NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, hash),
  FOREIGN KEY (scope, schema_id) REFERENCES schemas(scope, schema_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_turn_trees_scope_schema_id ON turn_trees(scope, schema_id);

CREATE TABLE turn_tree_paths (
  scope TEXT COLLATE "C" NOT NULL,
  turn_tree_hash TEXT COLLATE "C" NOT NULL,
  path TEXT COLLATE "C" NOT NULL,
  collection_kind TEXT COLLATE "C" NOT NULL,
  single_hash TEXT COLLATE "C" NULL,
  ordered_encoding TEXT COLLATE "C" NULL,
  ordered_count INTEGER NULL,
  ordered_inline_cbor BYTEA NULL,
  ordered_chunk_list_cbor BYTEA NULL,
  PRIMARY KEY (scope, turn_tree_hash, path),
  FOREIGN KEY (scope, turn_tree_hash) REFERENCES turn_trees(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_turn_tree_paths_scope_path_turn_tree_hash
  ON turn_tree_paths(scope, path, turn_tree_hash);

CREATE TABLE ordered_path_chunks (
  scope TEXT COLLATE "C" NOT NULL,
  chunk_hash TEXT COLLATE "C" NOT NULL,
  item_count INTEGER NOT NULL,
  items_cbor BYTEA NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, chunk_hash)
);

CREATE TABLE turn_nodes (
  scope TEXT COLLATE "C" NOT NULL,
  hash TEXT COLLATE "C" NOT NULL,
  previous_turn_node_hash TEXT COLLATE "C" NULL,
  turn_tree_hash TEXT COLLATE "C" NOT NULL,
  consumed_staged_results_cbor BYTEA NOT NULL,
  schema_id TEXT COLLATE "C" NOT NULL,
  event_hash TEXT COLLATE "C" NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, hash),
  FOREIGN KEY (scope, previous_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, turn_tree_hash) REFERENCES turn_trees(scope, hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, schema_id) REFERENCES schemas(scope, schema_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, event_hash) REFERENCES objects(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_turn_nodes_scope_previous_turn_node_hash
  ON turn_nodes(scope, previous_turn_node_hash);
CREATE INDEX idx_turn_nodes_scope_turn_tree_hash
  ON turn_nodes(scope, turn_tree_hash);

CREATE TABLE threads (
  scope TEXT COLLATE "C" NOT NULL,
  thread_id TEXT COLLATE "C" NOT NULL,
  schema_id TEXT COLLATE "C" NOT NULL,
  root_turn_node_hash TEXT COLLATE "C" NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, thread_id),
  FOREIGN KEY (scope, schema_id) REFERENCES schemas(scope, schema_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, root_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX idx_threads_scope_root_turn_node_hash
  ON threads(scope, root_turn_node_hash);
CREATE INDEX idx_threads_scope_created_at_ms_thread_id
  ON threads(scope, created_at_ms ASC, thread_id ASC);

CREATE TABLE branches (
  scope TEXT COLLATE "C" NOT NULL,
  branch_id TEXT COLLATE "C" NOT NULL,
  thread_id TEXT COLLATE "C" NOT NULL,
  head_turn_node_hash TEXT COLLATE "C" NOT NULL,
  archived_from_branch_id TEXT COLLATE "C" NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, branch_id),
  FOREIGN KEY (scope, thread_id) REFERENCES threads(scope, thread_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, head_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, archived_from_branch_id) REFERENCES branches(scope, branch_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_branches_scope_thread_id ON branches(scope, thread_id);
CREATE INDEX idx_branches_scope_head_turn_node_hash
  ON branches(scope, head_turn_node_hash);
CREATE INDEX idx_branches_scope_archived_from_branch_id
  ON branches(scope, archived_from_branch_id);

CREATE TABLE turns (
  scope TEXT COLLATE "C" NOT NULL,
  turn_id TEXT COLLATE "C" NOT NULL,
  thread_id TEXT COLLATE "C" NOT NULL,
  branch_id TEXT COLLATE "C" NOT NULL,
  parent_turn_id TEXT COLLATE "C" NULL,
  start_turn_node_hash TEXT COLLATE "C" NOT NULL,
  head_turn_node_hash TEXT COLLATE "C" NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, turn_id),
  FOREIGN KEY (scope, thread_id) REFERENCES threads(scope, thread_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, branch_id) REFERENCES branches(scope, branch_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, parent_turn_id) REFERENCES turns(scope, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, start_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, head_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_turns_scope_thread_id ON turns(scope, thread_id);
CREATE INDEX idx_turns_scope_branch_id ON turns(scope, branch_id);
CREATE INDEX idx_turns_scope_parent_turn_id ON turns(scope, parent_turn_id);
CREATE INDEX idx_turns_scope_thread_branch_head_turn_node
  ON turns(scope, thread_id, branch_id, head_turn_node_hash);

CREATE TABLE runs (
  scope TEXT COLLATE "C" NOT NULL,
  run_id TEXT COLLATE "C" NOT NULL,
  turn_id TEXT COLLATE "C" NOT NULL,
  branch_id TEXT COLLATE "C" NOT NULL,
  schema_id TEXT COLLATE "C" NOT NULL,
  start_turn_node_hash TEXT COLLATE "C" NOT NULL,
  status TEXT COLLATE "C" NOT NULL,
  current_step_index INTEGER NOT NULL,
  step_sequence_cbor BYTEA NOT NULL,
  created_turn_nodes_cbor BYTEA NOT NULL,
  pending_signals_cbor BYTEA NULL,
  execution_owner_id TEXT COLLATE "C" NULL,
  lease_expires_at_ms BIGINT NULL,
  fencing_token TEXT COLLATE "C" NULL,
  preemption_reason TEXT COLLATE "C" NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, run_id),
  FOREIGN KEY (scope, turn_id) REFERENCES turns(scope, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, branch_id) REFERENCES branches(scope, branch_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, schema_id) REFERENCES schemas(scope, schema_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, start_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_runs_scope_turn_id ON runs(scope, turn_id);
CREATE INDEX idx_runs_scope_branch_id ON runs(scope, branch_id);
CREATE INDEX idx_runs_scope_branch_id_status ON runs(scope, branch_id, status);
CREATE INDEX idx_runs_scope_status_lease_expires_at_ms
  ON runs(scope, status, lease_expires_at_ms);

CREATE TABLE staged_results (
  scope TEXT COLLATE "C" NOT NULL,
  run_id TEXT COLLATE "C" NOT NULL,
  task_id TEXT COLLATE "C" NOT NULL,
  object_hash TEXT COLLATE "C" NOT NULL,
  object_type TEXT COLLATE "C" NOT NULL,
  status TEXT COLLATE "C" NOT NULL,
  interrupt_payload_cbor BYTEA NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, run_id, task_id),
  FOREIGN KEY (scope, run_id) REFERENCES runs(scope, run_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, object_hash) REFERENCES objects(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_staged_results_scope_run_id_status
  ON staged_results(scope, run_id, status);
CREATE INDEX idx_staged_results_scope_object_hash
  ON staged_results(scope, object_hash);

CREATE TABLE observe_annotations (
  scope TEXT COLLATE "C" NOT NULL,
  record_key TEXT COLLATE "C" NOT NULL,
  run_id TEXT COLLATE "C" NOT NULL,
  annotation_hash TEXT COLLATE "C" NOT NULL,
  turn_node_hash TEXT COLLATE "C" NULL,
  annotation_cbor BYTEA NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, record_key),
  FOREIGN KEY (scope, run_id) REFERENCES runs(scope, run_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_observe_annotations_scope_run_id_created_at_ms
  ON observe_annotations(scope, run_id, created_at_ms);

CREATE TABLE turn_node_lineage_roots (
  scope TEXT COLLATE "C" NOT NULL,
  turn_node_hash TEXT COLLATE "C" NOT NULL,
  root_turn_node_hash TEXT COLLATE "C" NOT NULL,
  depth INTEGER NOT NULL,
  PRIMARY KEY (scope, turn_node_hash),
  FOREIGN KEY (scope, turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (scope, root_turn_node_hash) REFERENCES turn_nodes(scope, hash)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_turn_node_lineage_roots_scope_root_depth
  ON turn_node_lineage_roots(scope, root_turn_node_hash, depth);
