-- Hourly/manual sync lease and bounded operational history.
INSERT OR IGNORE INTO sync_leases(name,owner,lease_until,updated_at)
VALUES('sync-cycle','','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started
  ON sync_runs(started_at DESC);
