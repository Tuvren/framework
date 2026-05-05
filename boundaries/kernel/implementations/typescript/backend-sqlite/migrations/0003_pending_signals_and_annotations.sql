ALTER TABLE runs ADD COLUMN pending_signals_cbor BLOB NULL;
ALTER TABLE runs ADD COLUMN last_step_annotations_cbor BLOB NULL;
