/* 7-ELEVEN order form: barcode + pack minimum (PK) from supplied paper slip, Oct 2026.
   Monthly Focus/NEW are deliberately excluded. Admin-configured PK takes precedence. */
(function (root) {
  "use strict";
  const rows = [
    ["sme_foam_baby_face_2oz","5000233",3],
    ["sme_foam_green_baby_face_1_2oz","5000232",3],
    ["sme_baby_face_gel_1_5oz","5000300",3],
    ["sme_white_foam_1oz","5000245",3],
    ["sme_green_foam_0_5oz","5002206",6],
    ["sme_cleansing_water_80ml","5000390",3],
    ["sme_green_cream_10g","5007386",3],
    ["sme_plus_white","5001700",3],
    ["sme_acne_gel_5g_sachet","5010407",6],
    ["den_floss","5000109",3],
    ["den_tube_50g","5000592",3],
    ["den_travel_set","5000898",3],
    ["den_tube_100g","5000253",3],
    ["den_sensitive_100g","5001199",3],
    ["den_italy_3_action_80","5000715",6],
    ["den_tube_set_90x90g","5000880",3],
    ["den_premium_care_50g","5002148",3],
    ["den_brush_pack_3","5003574",3],
    ["den_mouth_spray","5004285",3],
    ["den_quality_max_45g","5005456",3],
    ["den_goodnight_pastel","5006586",6],
    ["den_floss_pick_40","5011564",3],
    ["den_sukiri_candy","4001662",12],
    ["den_proskin_6_capsules","1401046",3],
    ["den_proskin_12_capsules","1400004",3],
    ["sme_acne_scar_5g_sachet","5010627",6],
    ["sme_acne_sun_5g_sachet","5011314",6],
    ["sme_white_cream_5g_sachet","5011490",6],
    ["sme_white_baby_face_spot_clear_40ml","5011485",3],
    ["sme_gold_cream_5g_sachet","5011666",6],
    ["den_advanced_care_new","5012253",3],
    ["den_extra_strong_mint_100g","5012255",3],
    ["den_premium_natural_white_50g","5012254",3],
    ["sme_gluta_b3_5g_sachet","5012583",6],
    ["sme_radiant_glow_30ml_sachet","5012600",4],
    ["sme_sun_zero_feel_5g_new","5013078",6],
    ["den_whitening_purple_100g_new","5013085",3],
    ["den_whitening_purple_sachet_10g_new","5013083",3],
    ["sme_baby_face_acne_5_detoxify_new","5013698",3],
    ["sme_acne_cleansing_serum_80ml_new","5013841",3]
  ];
  const catalog = Object.create(null);
  rows.forEach(([id, barcode, pk], index) => { catalog[id] = Object.freeze({ barcode, pk, index }); });
  function positiveInt(value) {
    if (value === null || value === undefined || String(value).trim() === "") return 0;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 1 && n <= 9999 ? n : 0;
  }
  function resolve(id, custom) {
    const item = catalog[String(id)] || null;
    const configured = positiveInt(custom && custom.pk);
    const pk = configured || (item ? item.pk : 3);
    const barcode = String(custom && custom.barcode || (item && item.barcode) || "");
    return { pk, barcode, matched: !!item, configured: !!configured, slipIndex: item ? item.index : null };
  }
  root.PTOrderPkCatalog = Object.freeze({
    rows: Object.freeze(rows.map(row => Object.freeze([...row]))),
    resolve, positiveInt
  });
})(typeof window === "object" ? window : globalThis);
