# 7-ELEVEN Compact Report Popup + per-SKU PK (28 October 2026)

**Scope:** 7-ELEVEN account in CVS_PHANToM and CVS_SME; no modification of other accounts' layouts, routes or visit data.

- Replace the old `- | number | +` order control with an independent **ฝากสั่ง** checkbox.
- Selecting the order checkbox saves that SKU's PK immediately. The amount stays collapsed behind a > disclosure. Tapping > opens the quantity between order checkbox and <, allowing direct edits; tapping < hides only the input while keeping the saved number. Unchecking clears the order; rechecking resets to PK. Opening never summons the keyboard automatically.
- Valid new quantities are any integer at least the PK, up to 9999. No pack-multiple restriction and no old maximum of 12.
- Saved positive values are retained when reopening a report. An old value below a subsequently raised PK remains visible with an amber outline, not silently rewritten; editing enforces the latest minimum.
- `noted.orderQuantities`, Report COPY, LINE, and map persistence keep their original schema. Quantity normalization accepts 1–9999, not only 3/6/9/12.
- Compact style: zero inter-row gap, subtle separators and alternating backgrounds, 13px name typography, approximately 43px per single-line row at 360px screen width. Name may wrap if needed. The rightmost chevron stays anchored to the edge, while the order checkbox slides left to reveal the amount when opened. Wrapper widths: 35px unchecked, 69px selected/collapsed, 113px expanded (160ms, reduced-motion aware).
- Preserve the existing ReportAdmin `formSort` / configured SKU row order for every account. The paper-slip PK lookup must not reorder items. Previously forced paper-slip sorting was reverted on 28 October 2026.
- `Tools/order-pk.js` is a seed for 40 `[skuId, barcode, pk]` mappings transcribed from the October 2026 photo. Focus/NEW are **not** tracked as PK data. Seven other existing 7-ELEVEN SKUs have no confirmed PK in that slip and temporarily retain legacy 3; Admin marks them as `ยังไม่ยืนยัน`. Verify those before ordering.
- Admin may override PK and product code per SKU via `Tools/ReportAdmin.html`; overrides are kept in `report_config_sets.items_json` without new schema or D1 migrations. Do not bulk-edit live data just to populate the seed.

**Checks:** `node test/7eleven-report-compact.mjs`; syntax check embedded scripts. Local Chromium/Playwright tests for each repo passed at 360px: PK 4/6/12, check/uncheck/recheck, arbitrary quantity 8, reject below PK, preserve saved quantity 9, preserved configured SKU order, no row gap, account switching, and the Admin PK edit with a mocked API. Tests did not alter live store data.

**Backup:** `C:\Project_winsurf\_backups\report-compact-pk-2026-10-28\{CVS,CVS_SME}`.

Additional local Chromium checks cover slide-out open/close, unchanged PK and stored quantity, custom edits, collapse without data loss, saved-report prefill, legacy ReportAdmin order, and no horizontal overflow at 320, 360 or 390px.
