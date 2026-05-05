ALTER TABLE runs ADD COLUMN execution_owner_id TEXT NULL;
ALTER TABLE runs ADD COLUMN lease_expires_at_ms INTEGER NULL;
ALTER TABLE runs ADD COLUMN fencing_token TEXT NULL;
ALTER TABLE runs ADD COLUMN preemption_reason TEXT NULL;

CREATE INDEX idx_runs_status_lease_expires_at_ms
  ON runs(status, lease_expires_at_ms);
