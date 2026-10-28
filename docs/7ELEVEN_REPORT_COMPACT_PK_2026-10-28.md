# 7-ELEVEN Compact Report Popup + per-SKU PK (28 October 2026)

**Scope:** 7-ELEVEN account in CVS_PHANToM and CVS_SME; no modification of other accounts' layouts, routes or visit data.

- Replace the old `- | number | +` order control with an independent **ฝากสั่ง** checkbox.
- When selected, fill editable numeric quantity with that SKU's PK from the paper order slip (or configured admin override). No keyboard opens automatically. Unselecting removes the order, and reselecting resets to the PK.
- Valid new quantities are any integer at least the PK, up to 9999. No pack-multiple restriction and no old maximum of 12.
- Saved positive values are retained when reopening a report. An old value below a subsequently raised PK remains visible with an amber outline, not silently rewritten; editing enforces the latest minimum.
- `noted.orderQuantities`, Report COPY, LINE, and map persistence keep their original schema. Quantity normalization accepts 1–9999, not only 3/6/9/12.
- Compact style: zero inter-row gap, subtle separators and alternating backgrounds, 13px name typography, approximately 43px per single-line row at 360px screen width. Name may wrap if needed. The rightmost order checkbox stays anchored to the right: the separate quantity wrapper appears on its left only when selected. The outer control contracts to 35px unchecked and expands to 79px checked (160ms, reduced-motion aware).
- Preserve the existing ReportAdmin `formSort` / configured SKU row order for every account. The paper-slip PK lookup must not reorder items. Previously forced paper-slip sorting was reverted on 28 October 2026.
- `Tools/order-pk.js` is a seed for 40 `[skuId, barcode, pk]` mappings transcribed from the October 2026 photo. Focus/NEW are **not** tracked as PK data. Seven other existing 7-ELEVEN SKUs have no confirmed PK in that slip and temporarily retain legacy 3; Admin marks them as `ยังไม่ยืนยัน`. Verify those before ordering.
- Admin may override PK and product code per SKU via `Tools/ReportAdmin.html`; overrides are kept in `report_config_sets.items_json` without new schema or D1 migrations. Do not bulk-edit live data just to populate the seed.

**Checks:** `node test/7eleven-report-compact.mjs`; syntax check embedded scripts. Local Chromium/Playwright tests for each repo passed at 360px: PK 4/6/12, check/uncheck/recheck, arbitrary quantity 8, reject below PK, preserve saved quantity 9, preserved configured SKU order, no row gap, account switching, and the Admin PK edit with a mocked API. Tests did not alter live store data.

**Backup:** `C:\Project_winsurf\_backups\report-compact-pk-2026-10-28\{CVS,CVS_SME}`.
