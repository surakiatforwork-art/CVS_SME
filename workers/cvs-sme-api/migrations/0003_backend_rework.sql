ALTER TABLE stores
  ADD COLUMN sheet_noted_version TEXT NOT NULL DEFAULT '';
ALTER TABLE stores
  ADD COLUMN sheet_route_version TEXT NOT NULL DEFAULT '';
ALTER TABLE stores
  ADD COLUMN sheet_location_version TEXT NOT NULL DEFAULT '';
ALTER TABLE stores
  ADD COLUMN sheet_visit_version TEXT NOT NULL DEFAULT '';

UPDATE stores
SET sheet_noted_version = noted_version,
    sheet_route_version = route_version,
    sheet_location_version = location_version,
    sheet_visit_version = visit_version
WHERE sheet_noted_version = ''
   OR sheet_route_version = ''
   OR sheet_location_version = ''
   OR sheet_visit_version = '';

ALTER TABLE report_config_sets
  ADD COLUMN sheet_version TEXT NOT NULL DEFAULT '';

UPDATE report_config_sets
SET sheet_version = version
WHERE sheet_version = '';

CREATE TABLE IF NOT EXISTS inbound_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_nonces_expires
  ON inbound_nonces(expires_at);
