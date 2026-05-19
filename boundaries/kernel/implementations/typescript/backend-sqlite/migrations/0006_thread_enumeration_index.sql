-- ADR-034: covering index for thread.list enumeration (createdAtMs ASC, threadId ASC).
-- Enables efficient cursor-based pagination without a full table scan.
CREATE INDEX idx_threads_created_at_ms_thread_id
  ON threads(created_at_ms ASC, thread_id ASC);
