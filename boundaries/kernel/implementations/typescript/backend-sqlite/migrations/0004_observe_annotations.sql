CREATE TABLE observe_annotations (
  record_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  annotation_hash TEXT NOT NULL,
  turn_node_hash TEXT NULL,
  annotation_cbor BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (turn_node_hash) REFERENCES turn_nodes(hash)
);

CREATE INDEX idx_observe_annotations_run_id_created_at_ms
  ON observe_annotations(run_id, created_at_ms);
