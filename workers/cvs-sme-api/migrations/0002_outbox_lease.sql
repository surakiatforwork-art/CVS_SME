PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_outbox_due;

ALTER TABLE sync_outbox RENAME TO sync_outbox_old;

CREATE TABLE sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  team_id TEXT,
  store_id TEXT,
  account TEXT,
  request_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','error','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO sync_outbox(
  id,action,team_id,store_id,account,request_id,payload_json,status,
  attempt_count,next_attempt_at,last_error,created_at,updated_at
)
SELECT
  id,action,team_id,store_id,account,request_id,payload_json,status,
  attempt_count,next_attempt_at,last_error,created_at,updated_at
FROM sync_outbox_old;

DROP TABLE sync_outbox_old;

CREATE INDEX idx_outbox_due
  ON sync_outbox(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS sync_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO sync_leases(name,owner,lease_until,updated_at)
VALUES('outbox','','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z');

PRAGMA foreign_keys = ON;
