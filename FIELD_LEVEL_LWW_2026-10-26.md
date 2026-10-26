# Field-level merge and verified Last-Write-Wins — 2026-10-26

## Scope
CVS_PHANToM and CVS_SME Cloudflare Workers:
- Different fields in the same store (e.g. Sheets edits route, web edits noted and visited) are merged rather than marked as conflicting.
- Same logical field only: noted, route, location (lat/lng together), visit (visited + lastVisitedDate together).
- For a same-field disagreement, compare trusted **source event time** with the D1 pending write time. Sheet metadata must contain an ISO changedAt timestamp and SHA-256/base64url version hash matching the *exact current Sheet value*. Outbox created_at is the D1 write timestamp.
- If both verified and distinct, newer value wins. Otherwise preserve conflict; never substitute snapshot fetched time for edit time.
- If Sheets wins, mark only corresponding queued field jobs superseded. If D1 wins and the bridge supports compare-and-swap, rebase the latest field operation to the currently observed Sheet version and supersede older intermediate jobs.
- CVS_SME legacy bridge has no compare-and-swap, so automated D1-wins rebasing is **disabled** there to avoid overwriting unseen newer Sheet edits.
- Audit records 'field_lww' in audit_events include team/store, field, winning source, times, versions, and both field values.
- A visit reset must preserve lastVisitedDate; a team-wide reset is not automatically treated as independent per-store LWW.

## Phantom Apps Script source (production deployment @17)
- `apps-script/cvs-phantom-bridge-dev/Code.js` supplies optional `fieldMeta` per store from hidden `__SYNC_FIELD_TIMES`.
- `recordFieldTime_` tracks bridge-origin edits. A standalone Apps Script project requires a one-time *installable* spreadsheet onEdit trigger for human edits.
- To enable human edits, open the Apps Script project editor, choose `installFieldTrackingTrigger`, click Run, and authorize access. Running by clasp's remote execution API was attempted but denied by script API permissions; **activation is NOT verified**.
- Third-party Apps Script and external Sheets API writers MUST also call a field-time logger or pass verifiable edit timestamp metadata. Existing writers without such instrumentation remain safe-fallback conflicts if the same field changed on both sides.
- Do not assert that human-edit LWW works until trigger existence is verified and an actual human Sheet edit appears with matching `fieldMeta.version` in a fresh snapshot.

## CVS_SME source
- Worker supports the exact same signed `fieldMeta` contract; current legacy `code.gs.txt` deployed Google Apps Script is **not linked to the available clasp account**, so it is not instrumented or redeployed.
- Consequently, unrelated field changes merge normally, but same-field edits without verified Sheet timestamps remain conflicts.
- A later source bridge integration must provide version-bound `fieldMeta` and compare-and-swap to enable fully automatic both-direction LWW.

## Testing and production
- Synthetic tests `field-lww-merge.mjs` cover independent fields, newer Sheets, newer D1, and absent metadata fallback.
- Existing `hourly-sync-regression.mjs`, `sync-cycle-integration.mjs`, and D1 regression suites also run.
- No data-migration required: D1 outbox.created_at and audit_events are reused.
- Full D1 exports captured outside Git under `C:\Project_winsurf\_backups\field-lww-2026-10-26`.
- Workers remain hourly; manual ReportAdmin Sync remains immediate. Site status shows count of resolved LWW items in Sync History.
