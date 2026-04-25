CREATE TABLE turn_node_lineage_roots (
  turn_node_hash TEXT PRIMARY KEY,
  root_turn_node_hash TEXT NOT NULL,
  depth INTEGER NOT NULL,
  FOREIGN KEY (turn_node_hash) REFERENCES turn_nodes(hash),
  FOREIGN KEY (root_turn_node_hash) REFERENCES turn_nodes(hash)
);

WITH RECURSIVE lineage(turn_node_hash, root_turn_node_hash, depth) AS (
  SELECT hash, hash, 0
  FROM turn_nodes
  WHERE previous_turn_node_hash IS NULL
  UNION ALL
  SELECT turn_nodes.hash, lineage.root_turn_node_hash, lineage.depth + 1
  FROM turn_nodes
  JOIN lineage ON turn_nodes.previous_turn_node_hash = lineage.turn_node_hash
)
INSERT INTO turn_node_lineage_roots (
  turn_node_hash,
  root_turn_node_hash,
  depth
)
SELECT turn_node_hash, root_turn_node_hash, depth
FROM lineage;

CREATE INDEX idx_turn_node_lineage_roots_root_depth
  ON turn_node_lineage_roots(root_turn_node_hash, depth);

CREATE UNIQUE INDEX idx_threads_root_turn_node_hash
  ON threads(root_turn_node_hash);

CREATE INDEX idx_branches_archived_from_branch_id
  ON branches(archived_from_branch_id);

CREATE INDEX idx_turns_thread_branch_head_turn_node
  ON turns(thread_id, branch_id, head_turn_node_hash);
