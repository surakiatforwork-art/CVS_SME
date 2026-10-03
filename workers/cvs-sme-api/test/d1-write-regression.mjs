import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

assert.ok(
  !source.includes("UPDATE teams SET active=0,updated_at=? WHERE active=1"),
  "snapshot reconciliation must not deactivate every team on every pull",
);
assert.ok(source.includes("team_id NOT IN ("), "teams must deactivate only when absent");
assert.ok(source.includes("store_id NOT IN ("), "stores must deactivate only when absent");
assert.ok(
  source.includes("WHERE stores.master_version IS NOT excluded.master_version"),
  "store upsert must skip unchanged rows",
);
assert.ok(
  source.includes("WHERE report_config_sets.items_json IS NOT excluded.items_json"),
  "report config upsert must skip unchanged rows",
);

console.log("d1-write-regression: ok");
