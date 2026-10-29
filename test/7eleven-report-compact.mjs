import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ctx={window:{}};
runInNewContext(readFileSync(join(root,'Tools/order-pk.js'),'utf8'),ctx);
const catalog=ctx.window.PTOrderPkCatalog;
assert.equal(catalog.rows.length,40);
assert.equal(new Set(catalog.rows.map(row=>row[0])).size,40);
assert.equal(new Set(catalog.rows.map(row=>row[1])).size,40);
for(const [id,code,pk] of catalog.rows){assert.match(code,/^\d{7}$/,id);assert.ok([3,4,6,12].includes(pk),id)}
for(const [id,pk] of [['sme_green_foam_0_5oz',6],['sme_radiant_glow_30ml_sachet',4],['den_sukiri_candy',12],['sme_foam_baby_face_2oz',3]])assert.equal(catalog.resolve(id).pk,pk);
assert.equal(catalog.resolve('sme_green_foam_0_5oz',{pk:8}).pk,8);
assert.equal(catalog.resolve('unmatched_sku').matched,false);
assert.equal(catalog.resolve('unmatched_sku').pk,3);
for(const n of [3,4,6,8,9,12,24,9999])assert.equal(catalog.positiveInt(n),n);
for(const n of [0,-1,1.3,10000,'abc',null])assert.equal(catalog.positiveInt(n),0);
const html=readFileSync(join(root,'Tools/Report.html'),'utf8');
const admin=readFileSync(join(root,'Tools/ReportAdmin.html'),'utf8');
const map=readFileSync(join(root,'index.html'),'utf8');
assert.match(html,/data-role="order-check"/);
assert.match(html,/data-role="order-input"/);
assert.match(html,/skuCompact/);
assert.match(html,/changeOrderInput/);
assert.match(html,/data-role="order-quantity" hidden/);
assert.match(html,/class="skuOrderCheckWrap"/);
assert.match(html,/class="skuOrderQtyWrap"/);
assert.match(html,/is-order-selected/);
assert.match(html,/31px max-content/);
assert.ok(html.indexOf('data-role="order-check"') < html.indexOf('data-role="order-quantity" hidden'),
  'ordering checkbox appears before quantity in the closed/open slide layout');
assert.ok(html.indexOf('data-role="order-quantity" hidden') < html.indexOf('data-role="order-expand"'),
  'quantity slides between ordering checkbox and chevron');
assert.match(html,/class="skuOrderExpand"/);
assert.match(html,/is-order-expanded/);
assert.match(html,/toggleOrderQuantityDetails/);
assert.match(html,/function collapseOrderQuantityRow\(/);
assert.match(html,/function collapseOtherOrderQuantities\(/);
assert.match(html,/function commitPendingOrderQuantity\(/);
assert.match(html,/document\.addEventListener\("pointerdown"/);
assert.match(html,/expanded\.contains\(event\.target\)/);
assert.match(html,/collapseOtherOrderQuantities\(\);/);


assert.match(html,/function renderSkuLists\(\)/);
assert.match(html,/for \(const item of SKU_ITEMS\)/);
assert.doesNotMatch(html,/ordered\.sort\(/, 'must not override ReportAdmin SKU order');
assert.match(html,/data-role="order-minus"/);
assert.match(html,/data-role="order-plus"/);
assert.match(html,/changeOrderStep/);
assert.match(html,/\.skuOrderExpand\{/);
assert.match(html,/width:6\.6px/);
assert.match(html,/flex:0 0 26\.4px/);
assert.match(html,/skuOrderChoice\.is-order-selected\{ width:35px; \}/);
assert.match(html,/<svg class="skuOrderChevron" viewBox="0 0 8 12"/);
assert.match(html,/<path d="M2\.25 1\.5 5\.75 6 2\.25 10\.5"/);
assert.match(html,/skuOrderChoice\.is-order-expanded \.skuOrderChevron/);
assert.doesNotMatch(html,/expander\.textContent\s*=/,'no font-based arrow substitution');
assert.match(html,/skuOrderChoice\.is-order-selected\.is-order-expanded\{ width:119px/);
assert.match(html,/skuOrderChoice:not\(\.is-order-selected\) \.skuOrderCheckWrap/);

assert.match(html,/height:32px/);
assert.match(admin,/id="pk"/);
assert.match(admin,/id="barcode"/);
assert.match(map,/Number.isSafeInteger\(quantity\)/);
console.log('7-ELEVEN compact Report and PK regression passed');
