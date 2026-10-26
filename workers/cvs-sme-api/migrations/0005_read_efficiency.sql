-- Speed up recent-snapshot lookups and unresolved outbox scans without deleting data.
CREATE INDEX IF NOT EXISTS idx_sheet_inbound_events_received_at
  ON sheet_inbound_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_unresolved
  ON sync_outbox(status, id)
  WHERE status != 'done';
