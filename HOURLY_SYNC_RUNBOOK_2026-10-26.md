# Hourly bidirectional D1 / Sheets sync — 2026-10-26

## Contract
- Browser mutations persist to a single D1 store immediately and atomically create an outbox operation. No Sheets projection runs as a side effect of a normal mutation.
- Cloudflare Worker cron `0 * * * *` performs a bidirectional cycle once an hour, not every five minutes.
- Authorized ReportAdmin Sync triggers `POST /internal/sync` immediately even if there is no local report-config draft.
- The ReportAdmin Save button writes a draft to D1 without forcing Sheets sync.
- A completed pull happens **before** the outbound projection so concurrent Sheet edits can be detected.
- Same-field concurrent edits are never silently overwritten: the pending queue operation becomes `dead` with `last_error=CONCURRENT_SHEET_EDIT`, preserving the D1 and Sheets versions for human resolution.
- Manual retry may retry a previously backed-off `error` once, without retry loops or breaking job ordering.

## Incremental source reconciliation
- Worker still retrieves the complete source Sheet snapshot, because direct Sheet edits and external Apps Script/API writers do not always emit onEdit events.
- A full-payload SHA-256 fingerprint skips **all D1 store scans** for identical upstream snapshots.
- A per-team SHA-256 fingerprint restricts D1 store reads to changed teams. Changed store rows are selectively upserted; unchanged rows are not written.
- One forced daily reconciliation at 18:00 UTC (= 01:00 Thailand) re-checks every team.
- Pure delta transport FROM Sheets is **not** claimed: the legacy Apps Script source still reads Sheets to derive the snapshot.

## Operations
- `GET /internal/sync-history` (admin only): last 15 sync runs and latest 25 dead outbox records.
- `POST /internal/sync` (admin only) body `{"force":true}` bypasses fingerprint checks.
- A cycle will send up to 100 queued projections. Pending/error counts in its result indicate incomplete work; do not tell users it is fully synchronized when pending > 0.
- Errors and conflicts are visible in ReportAdmin. Conflicts require manual review and resolution; the system intentionally does not overwrite either side.
- Data updates while an hourly cycle is running are protected by D1 optimistic field versions.
- `sync_runs` retains 90 days after daily deep reconciliation. `audit_events` are not modified.

## Migration and rollback
- Applied migration: `0006_hourly_sync.sql` adds a sync-cycle lease and sync_runs history.
- Before-production full D1 exports saved outside Git at `C:\Project_winsurf\_backups\sync-cycle-2026-10-26`.
- Rollback of Worker behavior: redeploy prior Worker Git revision (migration is additive, can remain). DO NOT use D1 time-travel restore except as a deliberate data-loss recovery.
- Do not roll back D1 to a prechange bookmark without evaluating visits/notes/routes created afterward.

## Known limitations
- Direct edits to Sheets cannot be identified without reading Sheets, so a complete snapshot is still fetched hourly.
- Legacy Apps Script in CVS_SME does not guarantee compare-and-swap on all outside writes: a narrow race remains if another process edits the same Sheet cell **between** preflight and projection; see dead-conflict results and the daily deep reconciliation.
- Report configuration is currently stored as a single account-level JSON document, not per-item D1 rows.
- If a very large queue or Apps Script latency causes a partial cycle, its remaining count is reported and a later sync can resume. Do not discard pending jobs.
