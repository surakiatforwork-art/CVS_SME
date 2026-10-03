CREATE TABLE IF NOT EXISTS auth_login_attempts (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_updated
  ON auth_login_attempts(updated_at);
