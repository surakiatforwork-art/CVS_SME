PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  team_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  name TEXT NOT NULL,
  location_raw TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  maps_url TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  noted TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  visited INTEGER NOT NULL DEFAULT 0 CHECK (visited IN (0,1)),
  last_visited_date TEXT NOT NULL DEFAULT '',
  master_version TEXT NOT NULL,
  noted_version TEXT NOT NULL,
  route_version TEXT NOT NULL,
  location_version TEXT NOT NULL,
  visit_version TEXT NOT NULL,
  source_active INTEGER NOT NULL DEFAULT 1 CHECK (source_active IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, store_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stores_team_active
  ON stores(team_id, source_active, store_id);
CREATE INDEX IF NOT EXISTS idx_stores_account
  ON stores(account);

CREATE TABLE IF NOT EXISTS report_config_sets (
  account TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_idempotency (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','done')),
  operation_version TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_updated
  ON api_idempotency(updated_at);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  team_id TEXT,
  store_id TEXT,
  account TEXT,
  request_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','error')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON sync_outbox(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS sheet_inbound_events (
  event_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  origin TEXT NOT NULL,
  team_id TEXT,
  store_id TEXT,
  account TEXT,
  request_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_events(created_at);
