import assert from "node:assert/strict";
import worker from "../src/index.js";

class FakeStatement {
  constructor(sql) { this.sql = String(sql); this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all() {
    if (this.sql.includes("FROM teams WHERE active=1")) {
      return { results: [{ team_id: "DB_GBKK4", name: "DB_GBKK4" }] };
    }
    if (this.sql.includes("FROM stores") && this.sql.includes("source_active=1")) {
      return { results: [{
        store_id: "1", name: "Store 1", lat: 13.9, lng: 100.4,
        maps_url: "", account: "LAWSON", number: "P1", account_name: "Test",
        noted: "ทดสอบ", route: "1", visited: 0, last_visited_date: "",
        noted_version: "nv", route_version: "rv", location_version: "lv",
        visit_version: "vv", updated_at: "2026-10-01T00:00:00.000Z",
      }] };
    }
    if (this.sql.includes("GROUP BY status")) return { results: [] };
    return { results: [] };
  }
  async first() {
    if (this.sql.includes("FROM teams") && this.sql.includes("team_id=?")) {
      return { team_id: this.args[0], name: this.args[0] };
    }
    if (this.sql.includes("COUNT(*) AS n FROM teams")) return { n: 1 };
    if (this.sql.includes("COUNT(*) AS n FROM stores")) return { n: 1 };
    return null;
  }
  async run() { return { meta: { changes: 1 } }; }
}
const fakeDB = {
  prepare(sql) { return new FakeStatement(sql); },
  async batch() { return []; },
};

const baseEnv = {
  ENVIRONMENT: "test",
  SERVICE_API_TOKEN: "client-token",
  ALLOWED_ORIGINS: "https://example.test",
  ENABLE_ADMIN_MUTATIONS: "0",
};
const ctx = { waitUntil() {} };

async function call(path, init = {}, env = { ...baseEnv, DB: fakeDB }) {
  return worker.fetch(new Request("https://api.test" + path, init), env, ctx);
}

{
  const res = await call("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.backend, "d1");
  assert.equal(body.authConfigured, true);
}
{
  const res = await call("/health", {}, baseEnv);
  const body = await res.json();
  assert.equal(body.backend, "unconfigured");
}
{
  const res = await call("/v1/teams");
  assert.equal(res.status, 401);
}
{
  const sessionEnv = {
    ...baseEnv,
    SERVICE_API_TOKEN: "",
    SESSION_SECRET: "session-secret",
    ADMIN_ACCESS_CODE: "admin-code",
    USER_ACCESS_CODE: "legacy-user-code",
    DB: fakeDB,
  };
  const sessionRes = await call("/auth/user-session", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: "{}",
  }, sessionEnv);
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  assert.equal(session.role, "user");
  assert.ok(session.token.startsWith("pt1."));

  const teamsRes = await call("/v1/teams", {
    headers: { authorization: "Bearer " + session.token },
  }, sessionEnv);
  assert.equal(teamsRes.status, 200);

  const resetRes = await call("/v1/teams/DB_GBKK4/visits/reset", {
    method: "POST",
    headers: {
      authorization: "Bearer " + session.token,
      "content-type": "application/json",
      "idempotency-key": "user-reset-smoke",
    },
    body: "{}",
  }, sessionEnv);
  assert.equal(resetRes.status, 200);

  const legacyUserLogin = await call("/auth/login", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ code: "legacy-user-code" }),
  }, sessionEnv);
  assert.equal(legacyUserLogin.status, 403);

  const adminLogin = await call("/auth/login", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ code: "admin-code" }),
  }, sessionEnv);
  assert.equal(adminLogin.status, 200);
  assert.equal((await adminLogin.json()).role, "admin");
}
{
  const res = await call("/v1/teams", { headers: { authorization: "Bearer wrong" } });
  assert.equal(res.status, 403);
}
{
  const res = await call("/v1/teams", { headers: { authorization: "Bearer client-token" } }, baseEnv);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "D1_NOT_CONFIGURED");
}
{
  const res = await call("/v1/teams", { headers: { authorization: "Bearer client-token" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.teams, [{ id: "DB_GBKK4", name: "DB_GBKK4" }]);
}
{
  const res = await call("/v1/teams/DB_GBKK4/stores", {
    headers: { authorization: "Bearer client-token" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 1);
  assert.equal(body.stores[0].noted, "ทดสอบ");
  assert.equal(body.stores[0].routeVersion, "rv");
}
{
  const res = await call("/v1/teams", {
    method: "OPTIONS",
    headers: { origin: "https://example.test" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
}
{
  const res = await call("/v1/teams", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
}
{
  const res = await call("/v1/report-config/LAWSON", {
    method: "PUT",
    headers: {
      authorization: "Bearer client-token",
      "content-type": "application/json",
      "idempotency-key": "admin-disabled",
    },
    body: "{}",
  });
  assert.equal(res.status, 403);
}

console.log("worker-smoke: ok");
