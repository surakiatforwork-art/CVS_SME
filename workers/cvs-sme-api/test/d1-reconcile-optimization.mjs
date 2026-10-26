import assert from "node:assert/strict";
import { createHmac, createHash, randomUUID } from "node:crypto";
import worker from "../src/index.js";

const secret = "snapshot-test-secret";
const hashVersion = value => createHash("sha256").update(String(value)).digest("base64url").slice(0, 32);
const original = {
  id: "1", name: "Store 1", locationRaw: "13.9,100.4",
  mapsUrl: "", account: "LAWSON", number: "P1", account_name: "Test",
  noted: "", route: "1", visited: false, lastVisitedDate: "",
};
const stored = {
  team_id: "DB_GBKK4", store_id: original.id,
  name: original.name, location_raw: original.locationRaw,
  lat: 13.9, lng: 100.4, maps_url: "", account: "LAWSON",
  number: "P1", account_name: "Test", noted: original.noted,
  route: original.route, visited: 0, last_visited_date: "",
  source_active: 1, updated_at: "2026-10-01T00:00:00.000Z",
  master_version: "old-master", noted_version: "old-noted",
  route_version: "old-route", location_version: "old-location",
  visit_version: "old-visit",
  sheet_noted_version: hashVersion(original.noted),
  sheet_route_version: hashVersion(original.route),
  sheet_location_version: hashVersion(original.locationRaw),
  sheet_visit_version: hashVersion("0|"),
};

async function reconcile(existingStores, inputStores) {
  const recorded = [];
  const DB = {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return null; },
        async run() { return {meta: {changes: 1}}; },
        async all() {
          if (sql.includes("FROM stores") && !sql.includes("WHERE")) {
            return {results: existingStores};
          }
          return {results: []};
        },
      };
    },
    async batch(statements) {
      recorded.push(...statements.map(s => ({sql: s.sql, args: s.args})));
      return statements.map(() => ({meta: {changes: 1}}));
    },
  };
  const unsigned = {
    method: "POST", path: "/internal/sheet-snapshot",
    eventId: randomUUID(),
    payload: {
      complete: true,
      generatedAt: new Date().toISOString(),
      teams: [{teamId: "DB_GBKK4", name: "DB_GBKK4", stores: inputStores}],
      reportConfigSets: [],
    },
    ts: Date.now(), nonce: randomUUID(),
  };
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(unsigned)).digest("base64url");
  const req = new Request("https://worker.test/internal/sheet-snapshot", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({...unsigned, signature}),
  });
  const res = await worker.fetch(req, {
    DB, SHEET_SYNC_SECRET: secret, ALLOWED_TEAMS: "DB_GBKK4",
    ALLOWED_REPORT_ACCOUNTS: "LAWSON",
  }, {waitUntil(){}});
  assert.equal(res.status, 200, await res.text());
  return recorded;
}

const noop = await reconcile([stored], [original]);
assert.ok(!noop.some(s => /^(INSERT INTO stores|UPDATE stores)/.test(s.sql.trim())),
  "unchanged snapshots must not run store writes");

const removed = await reconcile([stored], []);
const inactive = removed.find(s => s.sql.includes("UPDATE stores"));
assert.ok(inactive, "deleted Sheet row must deactivate existing store");
assert.equal(JSON.parse(inactive.args[2])[0], original.id);

const changed = await reconcile([stored], [{...original, route: "2"}]);
const updated = changed.find(s => s.sql.includes("INSERT INTO stores"));
assert.ok(updated, "changed Sheet row must upsert");
assert.equal(JSON.parse(updated.args[0])[0].route, "2");

const added = await reconcile([], [original]);
assert.ok(added.some(s => s.sql.includes("INSERT INTO stores")),
  "new Sheet row must insert");

console.log("d1-reconcile-optimization: ok (no-op, remove, update, insert)");
