const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

class HttpError extends Error {
  constructor(status, code, message = code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          service: "cvs-sme-api",
          environment: env.ENVIRONMENT || "development",
          backend: env.DB ? "d1" : "unconfigured",
          authConfigured: Boolean(env.SERVICE_API_TOKEN || env.SESSION_SECRET),
          sessionAuthConfigured: Boolean(env.SESSION_SECRET && env.ADMIN_ACCESS_CODE),
          bridgeUrlConfigured: Boolean(env.LEGACY_API_URL || env.BRIDGE_URL),
          bridgeSecretConfigured: Boolean(env.BRIDGE_SECRET),
          bridgeConfigured: bridgeConfigured_(env),
        });
      }

      if (request.method === "OPTIONS") return preflight(request, env);

      if (request.method === "POST" && url.pathname === "/auth/login") {
        return withCors(await handleLogin(request, env), request, env);
      }

      if (request.method === "POST" && url.pathname === "/auth/user-session") {
        return withCors(await handleUserSession(env), request, env);
      }

      if (url.pathname === "/internal/sheet-snapshot") {
        return withCors(await handleSheetSnapshot(request, env), request, env);
      }

      const auth = await authorize(request, env);
      if (!auth.ok) return withCors(json({ ok: false, error: auth.error }, auth.status), request, env);
      if (!env.DB) return withCors(json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503), request, env);

      if (request.method === "GET" && url.pathname === "/auth/me") {
        return withCors(json({ok:true,role:auth.role,expiresAt:auth.expiresAt || null}), request, env);
      }

      if (request.method === "GET" && url.pathname === "/internal/status") {
        return withCors(await backendStatus(env), request, env);
      }

      if (request.method === "POST" && url.pathname === "/internal/pull-sheet") {
        if (!["admin","service"].includes(String(auth.role || ""))) {
          return withCors(json({ok:false,error:"ADMIN_REQUIRED"},403), request, env);
        }
        return withCors(json(await pullFreshSheetSnapshot(env)), request, env);
      }

      const route = matchRoute(request.method, url.pathname);
      if (!route) return json({ ok: false, error: "Not found" }, 404);
      enforceScope(env, route);
      if (route.admin && !["admin","service"].includes(String(auth.role || ""))) {
        return withCors(json({ ok:false,error:"ADMIN_REQUIRED" },403), request, env);
      }
      if (route.admin && env.ENABLE_ADMIN_MUTATIONS !== "1") {
        return withCors(json({ ok: false, error: "Admin mutations disabled" }, 403), request, env);
      }

      const body = route.read ? {} : await parseJsonBody(request);
      const requestId = route.read ? "" : requireIdempotencyKey(request);
      let response;

      switch (route.name) {
        case "teams":
          response = await getTeams(env);
          break;
        case "stores":
          response = await getStores(env, route.teamId);
          break;
        case "visit":
          response = await markVisited(env, route.teamId, route.storeId, requestId, ctx);
          break;
        case "resetVisits":
          response = await resetVisits(env, route.teamId, requestId, ctx);
          break;
        case "noted":
          response = await mutateStoreField(env, {
            teamId: route.teamId,
            storeId: route.storeId,
            requestId,
            field: "noted",
            value: body.noted ?? "",
            baseVersion: requireBaseVersion(body),
            bridgeAction: "saveNoted",
            bridgeValueKey: "noted",
          }, ctx);
          break;
        case "route":
          if (!Object.prototype.hasOwnProperty.call(body, "value")) {
            throw new HttpError(400, "BAD_REQUEST", "Missing route value");
          }
          response = await mutateStoreField(env, {
            teamId: route.teamId,
            storeId: route.storeId,
            requestId,
            field: "route",
            value: String(body.value ?? "").trim(),
            baseVersion: requireBaseVersion(body),
            bridgeAction: "updateRoute",
            bridgeValueKey: "route",
          }, ctx);
          break;
        case "location":
          response = await mutateLocation(env, route.teamId, route.storeId, body, requestId, ctx);
          break;
        case "reportConfig":
          response = await getReportConfig(env, route.account);
          break;
        case "saveReportConfig":
          response = await saveReportConfig(env, route.account, body, requestId, ctx);
          break;
        default:
          throw new HttpError(404, "NOT_FOUND");
      }

      return withCors(response, request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({
          ok: false,
          error: error.code,
          message: error.message,
          ...error.extra,
        }, error.status);
      }
      return json({
        ok: false,
        error: "BACKEND_ERROR",
        message: error && error.message ? error.message : String(error),
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processOutbox(env, 20));
    const interval = Math.max(5, Number(env.SHEET_PULL_INTERVAL_MIN || 15));
    const scheduledAt = Number(event?.scheduledTime || Date.now());
    if (new Date(scheduledAt).getUTCMinutes() % interval === 0) {
      ctx.waitUntil(pullFreshSheetSnapshot(env));
    }
  },
};

function matchRoute(method, pathname) {
  if (method === "GET" && pathname === "/v1/teams") return { name: "teams", read: true };

  let m = pathname.match(/^\/v1\/teams\/([^/]+)\/stores$/);
  if (method === "GET" && m) return { name: "stores", read: true, teamId: decode(m[1]) };

  m = pathname.match(/^\/v1\/teams\/([^/]+)\/stores\/([^/]+)\/visits$/);
  if (method === "POST" && m) return { name: "visit", teamId: decode(m[1]), storeId: decode(m[2]) };

  m = pathname.match(/^\/v1\/teams\/([^/]+)\/visits\/reset$/);
  if (method === "POST" && m) return { name: "resetVisits", teamId: decode(m[1]) };

  m = pathname.match(/^\/v1\/teams\/([^/]+)\/stores\/([^/]+)\/noted$/);
  if (method === "PUT" && m) return { name: "noted", teamId: decode(m[1]), storeId: decode(m[2]) };

  m = pathname.match(/^\/v1\/teams\/([^/]+)\/stores\/([^/]+)\/route$/);
  if (method === "PATCH" && m) return { name: "route", teamId: decode(m[1]), storeId: decode(m[2]) };

  m = pathname.match(/^\/v1\/teams\/([^/]+)\/stores\/([^/]+)\/location$/);
  if (method === "PATCH" && m) return { name: "location", teamId: decode(m[1]), storeId: decode(m[2]) };

  m = pathname.match(/^\/v1\/report-config\/([^/]+)$/);
  if (method === "GET" && m) return { name: "reportConfig", read: true, account: decode(m[1]) };
  if (method === "PUT" && m) return { name: "saveReportConfig", account: decode(m[1]), admin: true };

  return null;
}

async function getTeams(env) {
  const { results = [] } = await env.DB.prepare(
    "SELECT team_id,name FROM teams WHERE active=1 ORDER BY team_id"
  ).all();
  const allowedTeams = parseAllowlist(env.ALLOWED_TEAMS);
  const teams = results.filter(r => !allowedTeams.length || allowedTeams.includes(String(r.team_id)))
    .map(r => ({ id: r.team_id, name: r.name }));
  if (allowedTeams.length) {
    const order = new Map(allowedTeams.map((id,index) => [id,index]));
    teams.sort((a,b) => (order.get(String(a.id)) ?? 9999) - (order.get(String(b.id)) ?? 9999));
  }
  const configuredDefault = String(env.DEFAULT_TEAM_ID || "").trim();
  const defaultTeamId = teams.some(team => String(team.id) === configuredDefault)
    ? configuredDefault
    : (teams[0]?.id || "");
  return json({ ok: true, defaultTeamId, teams });
}

async function getStores(env, teamId) {
  const team = await env.DB.prepare(
    "SELECT team_id,name FROM teams WHERE team_id=? AND active=1"
  ).bind(teamId).first();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND");

  const { results = [] } = await env.DB.prepare(
    `SELECT store_id,name,lat,lng,maps_url,account,number,account_name,
            noted,route,visited,last_visited_date,noted_version,route_version,
            location_version,visit_version,updated_at
       FROM stores
      WHERE team_id=? AND source_active=1
      ORDER BY CAST(store_id AS INTEGER), store_id`
  ).bind(teamId).all();

  let visited = 0;
  let revision = "";
  const stores = results.map(row => {
    if (Number(row.visited) === 1) visited++;
    if (!revision || String(row.updated_at) > revision) revision = String(row.updated_at);
    return {
      id: String(row.store_id),
      name: row.name,
      lat: row.lat == null ? null : Number(row.lat),
      lng: row.lng == null ? null : Number(row.lng),
      mapsUrl: row.maps_url || "",
      account: row.account || "",
      number: row.number || "",
      account_name: row.account_name || "",
      noted: row.noted || "",
      notedVersion: row.noted_version,
      route: row.route || "",
      routeVersion: row.route_version,
      locationVersion: row.location_version,
      visited: Number(row.visited) === 1,
      lastVisitedDate: row.last_visited_date || "",
      visitVersion: row.visit_version,
    };
  });

  return json({
    ok: true,
    teamId,
    revision,
    schemaVersion: 3,
    total: stores.length,
    visited,
    remaining: stores.length - visited,
    stores,
  }, 200, { etag: quoteEtag(revision || "empty") });
}

async function getReportConfig(env, accountRaw) {
  const account = String(accountRaw || "").trim();
  const row = await env.DB.prepare(
    "SELECT items_json,version,updated_at FROM report_config_sets WHERE account=?"
  ).bind(account).first();
  if (!row) return json({ ok: true, account, items: [], version: "" });
  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch {}
  return json({ ok: true, account, items, version: row.version, updatedAt: row.updated_at });
}

async function mutateStoreField(env, spec, ctx) {
  const fieldMap = {
    noted: { valueCol: "noted", versionCol: "noted_version" },
    route: { valueCol: "route", versionCol: "route_version" },
  };
  const cfg = fieldMap[spec.field];
  if (!cfg) throw new HttpError(500, "FIELD_NOT_SUPPORTED");

  const value = String(spec.value ?? "");
  const targetVersion = await hashVersion(value);
  const requestPayload = {
    action: spec.bridgeAction,
    teamId: spec.teamId,
    storeId: spec.storeId,
    field: spec.field,
    value,
    baseVersion: spec.baseVersion,
  };
  const requestHash = await hashVersion(JSON.stringify(requestPayload));
  const response = {
    ok: true,
    id: String(spec.storeId),
    field: spec.field,
    value,
    version: targetVersion,
  };

  const prior = await resolveIdempotency(env, spec.requestId, requestHash, cfg.versionCol,
    spec.teamId, spec.storeId);
  if (prior) return json(prior);

  const current = await env.DB.prepare(
    `SELECT ${cfg.valueCol} AS value,${cfg.versionCol} AS version
       FROM stores WHERE team_id=? AND store_id=? AND source_active=1`
  ).bind(spec.teamId, spec.storeId).first();
  if (!current) throw new HttpError(404, "STORE_NOT_FOUND");
  if (String(current.version) !== String(spec.baseVersion)) {
    throw new HttpError(409, "VERSION_CONFLICT", "Stale field version", {
      currentVersion: current.version,
      currentValue: current.value ?? "",
    });
  }

  const now = new Date().toISOString();
  const bridgeParams = {
    sheet: spec.teamId,
    id: String(spec.storeId),
    [spec.bridgeValueKey]: value,
    baseVersion: spec.baseVersion,
    targetVersion,
  };
  const outboxRequestId = "projection:" + spec.requestId;

  const statements = [
    env.DB.prepare(
      `INSERT INTO api_idempotency
       (request_id,request_hash,status,operation_version,response_json,created_at,updated_at)
       VALUES(?,?,'pending',?,?,?,?)`
    ).bind(spec.requestId, requestHash, targetVersion, JSON.stringify(response), now, now),

    env.DB.prepare(
      `UPDATE stores SET ${cfg.valueCol}=?,${cfg.versionCol}=?,updated_at=?
        WHERE team_id=? AND store_id=? AND ${cfg.versionCol}=? AND source_active=1`
    ).bind(value, targetVersion, now, spec.teamId, spec.storeId, spec.baseVersion),

    env.DB.prepare(
      `INSERT INTO sync_outbox
       (action,team_id,store_id,request_id,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
       SELECT ?,?,?,?,?,'pending',0,?,?,?
       WHERE EXISTS(SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND ${cfg.versionCol}=?)`
    ).bind(spec.bridgeAction, spec.teamId, spec.storeId, outboxRequestId,
      JSON.stringify(bridgeParams), now, now, now, spec.teamId, spec.storeId, targetVersion),

    env.DB.prepare(
      `INSERT INTO audit_events(event_type,origin,team_id,store_id,request_id,payload_json,created_at)
       SELECT ?,'worker_api',?,?,?,?,?
       WHERE EXISTS(SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND ${cfg.versionCol}=?)`
    ).bind(spec.field, spec.teamId, spec.storeId, spec.requestId,
      JSON.stringify({ value, version: targetVersion }), now,
      spec.teamId, spec.storeId, targetVersion),

    env.DB.prepare(
      `UPDATE api_idempotency SET status='done',updated_at=?
        WHERE request_id=? AND EXISTS(
          SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND ${cfg.versionCol}=?
        )`
    ).bind(now, spec.requestId, spec.teamId, spec.storeId, targetVersion),
  ];

  let batch;
  try {
    batch = await env.DB.batch(statements);
  } catch (err) {
    const recovered = await resolveIdempotency(env, spec.requestId, requestHash, cfg.versionCol,
      spec.teamId, spec.storeId);
    if (recovered) return json(recovered);
    throw err;
  }

  if (Number(batch?.[1]?.meta?.changes || 0) < 1) {
    const fresh = await env.DB.prepare(
      `SELECT ${cfg.valueCol} AS value,${cfg.versionCol} AS version
         FROM stores WHERE team_id=? AND store_id=?`
    ).bind(spec.teamId, spec.storeId).first();
    if (String(fresh?.version || "") === targetVersion) {
      await env.DB.prepare(
        "UPDATE api_idempotency SET status='done',updated_at=? WHERE request_id=?"
      ).bind(new Date().toISOString(), spec.requestId).run();
      return json(response);
    }
    // The CAS definitely did not apply this request, so this is not an
    // indeterminate receipt. Remove only this known-failed pending claim.
    await env.DB.prepare(
      "DELETE FROM api_idempotency WHERE request_id=? AND status='pending'"
    ).bind(spec.requestId).run();
    throw new HttpError(409, "VERSION_CONFLICT", "Stale field version", {
      currentVersion: fresh?.version || "",
      currentValue: fresh?.value ?? "",
    });
  }

  ctx.waitUntil(processOutbox(env, 2));
  return json(response);
}

async function mutateLocation(env, teamId, storeId, body, requestId, ctx) {
  if (body.lat == null || body.lng == null) {
    throw new HttpError(400, "BAD_REQUEST", "Missing coordinates");
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid coordinates");
  }
  const baseVersion = requireBaseVersion(body);
  const raw = lat + "," + lng;
  const targetVersion = await hashVersion(raw);
  const requestPayload = { action: "updateLocation", teamId, storeId, lat, lng, baseVersion };
  const requestHash = await hashVersion(JSON.stringify(requestPayload));
  const response = { ok: true, id: String(storeId), field: "location", lat, lng, value: raw, version: targetVersion };

  const prior = await resolveIdempotency(env, requestId, requestHash, "location_version", teamId, storeId);
  if (prior) return json(prior);

  const current = await env.DB.prepare(
    "SELECT location_raw AS value,location_version AS version FROM stores WHERE team_id=? AND store_id=? AND source_active=1"
  ).bind(teamId, storeId).first();
  if (!current) throw new HttpError(404, "STORE_NOT_FOUND");
  if (String(current.version) !== String(baseVersion)) {
    throw new HttpError(409, "VERSION_CONFLICT", "Stale field version", {
      currentVersion: current.version,
      currentValue: current.value || "",
    });
  }

  const now = new Date().toISOString();
  const bridgeParams = { sheet: teamId, id: String(storeId), lat, lng, baseVersion, targetVersion };
  const projectionId = "projection:" + requestId;
  const statements = [
    env.DB.prepare(
      `INSERT INTO api_idempotency
       (request_id,request_hash,status,operation_version,response_json,created_at,updated_at)
       VALUES(?,?,'pending',?,?,?,?)`
    ).bind(requestId, requestHash, targetVersion, JSON.stringify(response), now, now),
    env.DB.prepare(
      `UPDATE stores SET location_raw=?,lat=?,lng=?,location_version=?,updated_at=?
        WHERE team_id=? AND store_id=? AND location_version=? AND source_active=1`
    ).bind(raw, lat, lng, targetVersion, now, teamId, storeId, baseVersion),
    env.DB.prepare(
      `INSERT INTO sync_outbox
       (action,team_id,store_id,request_id,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
       SELECT 'updateLocation',?,?,?,?,'pending',0,?,?,?
       WHERE EXISTS(SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND location_version=?)`
    ).bind(teamId, storeId, projectionId, JSON.stringify(bridgeParams), now, now, now,
      teamId, storeId, targetVersion),
    env.DB.prepare(
      `INSERT INTO audit_events(event_type,origin,team_id,store_id,request_id,payload_json,created_at)
       SELECT 'location','worker_api',?,?,?,?,?
       WHERE EXISTS(SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND location_version=?)`
    ).bind(teamId, storeId, requestId, JSON.stringify({lat,lng,version:targetVersion}), now,
      teamId, storeId, targetVersion),
    env.DB.prepare(
      `UPDATE api_idempotency SET status='done',updated_at=?
        WHERE request_id=? AND EXISTS(
          SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND location_version=?
        )`
    ).bind(now, requestId, teamId, storeId, targetVersion),
  ];

  let batch;
  try {
    batch = await env.DB.batch(statements);
  } catch (err) {
    const recovered = await resolveIdempotency(
      env, requestId, requestHash, "location_version", teamId, storeId
    );
    if (recovered) return json(recovered);
    throw err;
  }
  if (Number(batch?.[1]?.meta?.changes || 0) < 1) {
    const fresh = await env.DB.prepare(
      "SELECT location_raw AS value,location_version AS version FROM stores WHERE team_id=? AND store_id=?"
    ).bind(teamId, storeId).first();
    if (String(fresh?.version || "") === targetVersion) {
      await env.DB.prepare(
        "UPDATE api_idempotency SET status='done',updated_at=? WHERE request_id=?"
      ).bind(new Date().toISOString(), requestId).run();
      return json(response);
    }
    await env.DB.prepare(
      "DELETE FROM api_idempotency WHERE request_id=? AND status='pending'"
    ).bind(requestId).run();
    throw new HttpError(409, "VERSION_CONFLICT", "Stale field version", {
      currentVersion: fresh?.version || "",
      currentValue: fresh?.value || "",
    });
  }

  ctx.waitUntil(processOutbox(env, 2));
  return json(response);
}

async function markVisited(env, teamId, storeId, requestId, ctx) {
  const current = await env.DB.prepare(
    "SELECT visit_version,visited,last_visited_date FROM stores WHERE team_id=? AND store_id=? AND source_active=1"
  ).bind(teamId, storeId).first();
  if (!current) throw new HttpError(404, "STORE_NOT_FOUND");

  const date = bangkokDate();
  const targetVersion = await hashVersion("1|" + date);
  // Idempotency represents the logical visit action, not the server clock.
  // A retry after Bangkok midnight must still resolve to the original receipt.
  const payload = { action: "markVisited", teamId, storeId };
  const requestHash = await hashVersion(JSON.stringify(payload));
  const response = { ok: true, id: String(storeId), visited: true, lastVisitedDate: date, visitVersion: targetVersion };

  const prior = await resolveIdempotency(env, requestId, requestHash, "visit_version", teamId, storeId);
  if (prior) return json(prior);

  const now = new Date().toISOString();
  const bridgeParams = {
    sheet: teamId,
    id: String(storeId),
    baseVersion: current.visit_version,
    targetVersion,
  };
  const statements = [
    env.DB.prepare(
      `INSERT INTO api_idempotency
       (request_id,request_hash,status,operation_version,response_json,created_at,updated_at)
       VALUES(?,?,'pending',?,?,?,?)`
    ).bind(requestId, requestHash, targetVersion, JSON.stringify(response), now, now),
    env.DB.prepare(
      "UPDATE stores SET visited=1,last_visited_date=?,visit_version=?,updated_at=? WHERE team_id=? AND store_id=? AND visit_version=? AND source_active=1"
    ).bind(date, targetVersion, now, teamId, storeId, current.visit_version),
    env.DB.prepare(
      `INSERT INTO sync_outbox
       (action,team_id,store_id,request_id,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
      SELECT 'markVisited',?,?,?,?,'pending',0,?,?,?
       WHERE EXISTS(SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND visit_version=?)`
    ).bind(teamId, storeId, "projection:" + requestId, JSON.stringify(bridgeParams), now, now, now, teamId, storeId, targetVersion),
    env.DB.prepare(
      `INSERT INTO audit_events(event_type,origin,team_id,store_id,request_id,payload_json,created_at)
       SELECT 'visit','worker_api',?,?,?,?,?
       WHERE EXISTS(SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND visit_version=?)`
    ).bind(teamId, storeId, requestId, JSON.stringify({visited:true,lastVisitedDate:date}), now,
      teamId, storeId, targetVersion),
    env.DB.prepare(
      `UPDATE api_idempotency SET status='done',updated_at=?
        WHERE request_id=? AND EXISTS(
          SELECT 1 FROM stores WHERE team_id=? AND store_id=? AND visit_version=?
        )`
    ).bind(now, requestId, teamId, storeId, targetVersion),
  ];
  let batch;
  try {
    batch = await env.DB.batch(statements);
  } catch (err) {
    const recovered = await resolveIdempotency(
      env, requestId, requestHash, "visit_version", teamId, storeId
    );
    if (recovered) return json(recovered);
    throw err;
  }
  if (Number(batch?.[1]?.meta?.changes || 0) < 1) {
    const fresh = await env.DB.prepare(
      "SELECT visit_version FROM stores WHERE team_id=? AND store_id=?"
    ).bind(teamId, storeId).first();
    if (String(fresh?.visit_version || "") === targetVersion) {
      await env.DB.prepare(
        "UPDATE api_idempotency SET status='done',updated_at=? WHERE request_id=?"
      ).bind(new Date().toISOString(), requestId).run();
      return json(response);
    }
    await env.DB.prepare(
      "DELETE FROM api_idempotency WHERE request_id=? AND status='pending'"
    ).bind(requestId).run();
    throw new HttpError(409, "VERSION_CONFLICT", "Stale visit version", {
      currentVersion:fresh?.visit_version || ""
    });
  }
  ctx.waitUntil(processOutbox(env, 2));
  return json(response);
}

async function resetVisits(env, teamId, requestId, ctx) {
  const requestHash = await hashVersion(JSON.stringify({action:"resetVisitedAll",teamId}));
  const prior = await resolveSimpleIdempotency(env, requestId, requestHash);
  if (prior) return json(prior);
  const team = await env.DB.prepare("SELECT team_id FROM teams WHERE team_id=? AND active=1").bind(teamId).first();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND");

  const visitVersion = await hashVersion("0|");
  const now = new Date().toISOString();
  const response = { ok: true, teamId, reset: true, visitVersion };
  const statements = [
    env.DB.prepare(
      `INSERT INTO api_idempotency
       (request_id,request_hash,status,operation_version,response_json,created_at,updated_at)
       VALUES(?,?,'pending',?,?,?,?)`
    ).bind(requestId, requestHash, visitVersion, JSON.stringify(response), now, now),
    env.DB.prepare(
      "UPDATE stores SET visited=0,last_visited_date='',visit_version=?,updated_at=? WHERE team_id=? AND source_active=1"
    ).bind(visitVersion, now, teamId),
    env.DB.prepare(
      `INSERT INTO sync_outbox
       (action,team_id,request_id,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
       VALUES('resetVisitedAll',?,?,?,'pending',0,?,?,?)`
    ).bind(teamId, "projection:" + requestId, JSON.stringify({sheet:teamId,targetVersion:visitVersion}), now, now, now),
    env.DB.prepare(
      `INSERT INTO audit_events(event_type,origin,team_id,request_id,payload_json,created_at)
       VALUES('reset_visits','worker_api',?,?,?,?)`
    ).bind(teamId, requestId, JSON.stringify({visitVersion}), now),
    env.DB.prepare("UPDATE api_idempotency SET status='done',updated_at=? WHERE request_id=?")
      .bind(now, requestId),
  ];
  try {
    await env.DB.batch(statements);
  } catch (err) {
    const recovered = await resolveSimpleIdempotency(env, requestId, requestHash);
    if (recovered) return json(recovered);
    throw err;
  }
  ctx.waitUntil(processOutbox(env, 2));
  return json(response);
}

async function saveReportConfig(env, accountRaw, body, requestId, ctx) {
  const account = String(accountRaw || "").trim();
  if (!Array.isArray(body.items) || !body.items.length) {
    throw new HttpError(400, "BAD_REQUEST", "items must be a nonempty array");
  }
  const baseVersion = requireBaseVersion(body);
  const requestItems = body.items.map(item => ({
    account,
    kind: String(item.kind || "").trim(),
    id: String(item.id || "").trim(),
    sort: Number(item.sort || 0),
    active: item.active !== false,
    data: item.data ?? {},
    updatedAt: String(item.updatedAt || ""),
  })).filter(item => item.kind && item.id)
    .sort((a,b)=>a.sort-b.sort || a.id.localeCompare(b.id));
  if (!requestItems.length) throw new HttpError(400, "BAD_REQUEST", "No valid config items");

  // Keep the idempotency hash independent from a server-generated timestamp.
  // A retry of the same body/key must resolve to the first receipt.
  const requestHash = await hashVersion(JSON.stringify({
    action:"saveReportConfig", account, items:requestItems, baseVersion,
  }));
  const existingIdem = await resolveSimpleIdempotency(env, requestId, requestHash);
  if (existingIdem) return json(existingIdem);

  const now = new Date().toISOString();
  const items = requestItems.map(item => ({
    ...item,
    updatedAt: item.updatedAt || now,
  }));
  const itemsJson = JSON.stringify(items);
  const targetVersion = await hashVersion(itemsJson);
  const response = { ok: true, account, count: items.length, version: targetVersion };

  const current = await env.DB.prepare(
    "SELECT version FROM report_config_sets WHERE account=?"
  ).bind(account).first();
  const currentVersion = current?.version || "";
  if (String(baseVersion) !== String(currentVersion)) {
    throw new HttpError(409, "VERSION_CONFLICT", "Stale config version", {
      currentVersion,
    });
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO api_idempotency
       (request_id,request_hash,status,operation_version,response_json,created_at,updated_at)
       VALUES(?,?,'pending',?,?,?,?)`
    ).bind(requestId, requestHash, targetVersion, JSON.stringify(response), now, now),
    env.DB.prepare(
      `INSERT INTO report_config_sets(account,items_json,version,sheet_version,updated_at)
       VALUES(?,?,?,'',?)
       ON CONFLICT(account) DO UPDATE SET items_json=excluded.items_json,
         version=excluded.version,updated_at=excluded.updated_at
       WHERE report_config_sets.version=?`
    ).bind(account, itemsJson, targetVersion, now, baseVersion),
    env.DB.prepare(
      `INSERT INTO sync_outbox
       (action,account,request_id,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
       SELECT 'saveReportConfigBulk',?,?,?,'pending',0,?,?,?
       WHERE EXISTS(SELECT 1 FROM report_config_sets WHERE account=? AND version=?)`
    ).bind(account, "projection:" + requestId,
      JSON.stringify({items, d1BaseVersion:baseVersion,targetVersion}), now, now, now, account, targetVersion),
    env.DB.prepare(
      `INSERT INTO audit_events(event_type,origin,account,request_id,payload_json,created_at)
       SELECT 'report_config','worker_api',?,?,?,?
       WHERE EXISTS(SELECT 1 FROM report_config_sets WHERE account=? AND version=?)`
    ).bind(account, requestId, JSON.stringify({count:items.length,version:targetVersion}), now,
      account, targetVersion),
    env.DB.prepare(
      `UPDATE api_idempotency SET status='done',updated_at=?
        WHERE request_id=? AND EXISTS(
          SELECT 1 FROM report_config_sets WHERE account=? AND version=?
        )`
    ).bind(now, requestId, account, targetVersion),
  ];
  let batch;
  try {
    batch = await env.DB.batch(statements);
  } catch (err) {
    const recovered = await resolveSimpleIdempotency(env, requestId, requestHash);
    if (recovered) return json(recovered);
    throw err;
  }
  if (Number(batch?.[1]?.meta?.changes || 0) < 1) {
    const fresh = await env.DB.prepare("SELECT version FROM report_config_sets WHERE account=?")
      .bind(account).first();
    if (String(fresh?.version || "") === targetVersion) {
      await env.DB.prepare(
        "UPDATE api_idempotency SET status='done',updated_at=? WHERE request_id=?"
      ).bind(new Date().toISOString(), requestId).run();
      return json(response);
    }
    await env.DB.prepare(
      "DELETE FROM api_idempotency WHERE request_id=? AND status='pending'"
    ).bind(requestId).run();
    throw new HttpError(409, "VERSION_CONFLICT", "Stale config version", {
      currentVersion: fresh?.version || "",
    });
  }
  ctx.waitUntil(processOutbox(env, 2));
  return json(response);
}

async function resolveIdempotency(env, requestId, requestHash, versionCol, teamId, storeId) {
  const existing = await env.DB.prepare(
    "SELECT request_hash,status,operation_version,response_json FROM api_idempotency WHERE request_id=?"
  ).bind(requestId).first();
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with different payload");
  }
  if (existing.status === "done") return JSON.parse(existing.response_json || "{}");
  // A pending receipt is deliberately durable: the original batch may have
  // committed while its response was lost. Retrying it must never duplicate it.
  throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "Request is still being resolved");
}

async function resolveSimpleIdempotency(env, requestId, requestHash) {
  const existing = await env.DB.prepare(
    "SELECT request_hash,status,response_json FROM api_idempotency WHERE request_id=?"
  ).bind(requestId).first();
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with different payload");
  }
  if (existing.status === "done") return JSON.parse(existing.response_json || "{}");
  throw new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", "Request is still being resolved");
}

async function processOutbox(env, limit = 10) {
  if (!env.DB || !bridgeConfigured_(env)) return { processed: 0 };

  const owner = crypto.randomUUID();
  const leaseMs = 120000;
  const acquireAt = new Date();
  const acquireUntil = new Date(acquireAt.getTime() + leaseMs).toISOString();
  const acquired = await env.DB.prepare(
    `UPDATE sync_leases
        SET owner=?,lease_until=?,updated_at=?
      WHERE name='outbox' AND lease_until<=?`
  ).bind(owner, acquireUntil, acquireAt.toISOString(), acquireAt.toISOString()).run();
  if (Number(acquired?.meta?.changes || 0) !== 1) {
    return { processed: 0, busy: true };
  }

  let processed = 0;
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - leaseMs).toISOString();
    await env.DB.prepare(
      `UPDATE sync_outbox
          SET status='error',last_error=COALESCE(last_error,'STALE_PROCESSING'),
              next_attempt_at=?,updated_at=?
        WHERE status='processing' AND updated_at<?`
    ).bind(nowIso, nowIso, staleBefore).run();

    for (let i = 0; i < limit; i++) {
      const refreshAt = new Date();
      const refreshUntil = new Date(refreshAt.getTime() + leaseMs).toISOString();
      const refreshed = await env.DB.prepare(
        `UPDATE sync_leases
            SET lease_until=?,updated_at=?
          WHERE name='outbox' AND owner=?`
      ).bind(refreshUntil, refreshAt.toISOString(), owner).run();
      if (Number(refreshed?.meta?.changes || 0) !== 1) {
        return { processed, leaseLost: true };
      }

      const due = refreshAt.toISOString();
      // Preserve projection order globally. A transient failure on an older
      // operation must not let a newer reset/visit or field write overtake it.
      const job = await env.DB.prepare(
        `SELECT id,action,team_id,store_id,account,request_id,payload_json,attempt_count,next_attempt_at
           FROM sync_outbox
          WHERE status IN ('pending','error')
          ORDER BY id LIMIT 1`
      ).first();
      if (!job) break;
      if (String(job.next_attempt_at || "") > due) break;

      const claimedAt = new Date().toISOString();
      const claim = await env.DB.prepare(
        `UPDATE sync_outbox SET status='processing',updated_at=?
          WHERE id=? AND status IN ('pending','error') AND next_attempt_at<=?`
      ).bind(claimedAt, job.id, due).run();
      if (Number(claim?.meta?.changes || 0) !== 1) continue;

      let params = {};
      try { params = JSON.parse(job.payload_json || "{}"); } catch {}

      if (job.action === "saveReportConfigBulk") {
        params = {
          items: params.items || [],
          requestId: job.request_id,
          baseVersion: params.d1BaseVersion || params.baseVersion || "",
          targetVersion: params.targetVersion || "",
        };
      }

      try {
        const result = await bridgeCall(env, job.action, params, job.request_id);
        if (!result || result.ok !== true) {
          const code = String(result?.error || result?.message || "BRIDGE_REJECTED");
          if (["VERSION_CONFLICT","IDEMPOTENCY_CONFLICT","INDETERMINATE_REQUIRES_RECONCILIATION"].includes(code)) {
            await env.DB.prepare(
              `UPDATE sync_outbox
                  SET status='dead',attempt_count=attempt_count+1,last_error=?,
                      next_attempt_at=?,updated_at=?
                WHERE id=?`
            ).bind(code, farFuture(), new Date().toISOString(), job.id).run();
          } else {
            throw new Error(code);
          }
        } else {
          await updateSheetShadow(env, job, params);
          await env.DB.prepare(
            "UPDATE sync_outbox SET status='done',last_error=NULL,updated_at=? WHERE id=?"
          ).bind(new Date().toISOString(), job.id).run();
          processed++;
        }
      } catch (err) {
        const attempts = Number(job.attempt_count || 0) + 1;
        const delay = Math.min(3600, 30 * (2 ** Math.min(attempts, 7)));
        const next = new Date(Date.now() + delay * 1000).toISOString();
        await env.DB.prepare(
          `UPDATE sync_outbox
              SET status=?,attempt_count=?,last_error=?,next_attempt_at=?,updated_at=?
            WHERE id=?`
        ).bind(attempts >= 8 ? 'dead' : 'error', attempts, String(err?.message || err).slice(0,500), attempts >= 8 ? farFuture() : next, new Date().toISOString(), job.id).run();
      }
    }
    return { processed };
  } finally {
    await env.DB.prepare(
      `UPDATE sync_leases
          SET owner='',lease_until='1970-01-01T00:00:00.000Z',updated_at=?
        WHERE name='outbox' AND owner=?`
    ).bind(new Date().toISOString(), owner).run();
  }
}

async function pullFreshSheetSnapshot(env) {
  if (!env.DB || !bridgeConfigured_(env) || !env.SHEET_SYNC_SECRET) {
    return {ok:false,skipped:true,error:"SHEET_PULL_NOT_CONFIGURED"};
  }

  let payload = null;
  let lastBridgeError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const candidate = await bridgeCall(env, "getFreshSheetSnapshot", {}, "");
      if (!candidate || candidate.complete !== true) {
        throw new Error("Bridge returned an incomplete Sheet snapshot");
      }
      payload = candidate;
      break;
    } catch (error) {
      lastBridgeError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  if (!payload) throw lastBridgeError || new Error("Sheet snapshot pull failed");

  const eventId = "worker-pull:" + String(payload.generatedAt || "") + ":" + crypto.randomUUID();
  const ts = Date.now();
  const nonce = crypto.randomUUID();
  const unsigned = {
    method:"POST",
    path:"/internal/sheet-snapshot",
    eventId,
    payload,
    ts,
    nonce,
  };
  const signature = await hmacBase64Url(env.SHEET_SYNC_SECRET, JSON.stringify(unsigned));
  const request = new Request("https://worker.internal/internal/sheet-snapshot", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({...unsigned, signature}),
  });
  const response = await handleSheetSnapshot(request, env);
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error("Internal Sheet reconciliation returned invalid JSON"); }
  if (!response.ok || result?.ok !== true) {
    throw new Error("Internal Sheet reconciliation failed: " + text.slice(0,500));
  }
  return result;
}

function bridgeConfigured_(env) {
  return Boolean(env.LEGACY_API_URL || (env.BRIDGE_URL && env.BRIDGE_SECRET));
}

async function bridgeCall(env, action, params, requestId) {
  if (env.LEGACY_API_URL) {
    return legacyBridgeCall_(env, action, params || {}, requestId || "");
  }

  const ts = Date.now();
  const nonce = crypto.randomUUID();
  const unsigned = { method:"POST", path:"/bridge", action, params: params || {}, requestId: requestId || "", ts, nonce };
  const canonical = JSON.stringify(unsigned);
  const signature = await hmacBase64Url(env.BRIDGE_SECRET, canonical);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.BRIDGE_TIMEOUT_MS || 45000));
  try {
    const res = await fetch(env.BRIDGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...unsigned, signature }),
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error("Bridge returned invalid JSON"); }
    if (!res.ok) throw new Error("Bridge HTTP " + res.status);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function legacyBridgeCall_(env, action, params, requestId) {
  if (action === "getFreshSheetSnapshot") {
    return legacyFreshSheetSnapshot_(env);
  }
  if (action === "saveReportConfigBulk") {
    return legacyFetchJson_(env, null, {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        action:"saveReportConfigBulk",
        items:Array.isArray(params.items) ? params.items : [],
        requestId:String(requestId || params.requestId || ""),
      }),
    });
  }

  const query = {action};
  if (params.sheet != null) query.sheet = params.sheet;
  if (params.id != null) query.id = params.id;
  if (action === "saveNoted") query.noted = params.noted ?? "";
  if (action === "updateRoute") query.route = params.route ?? "";
  if (action === "updateLocation") {
    query.lat = params.lat ?? "";
    query.lng = params.lng ?? "";
  }
  return legacyFetchJson_(env, query);
}

async function legacyFreshSheetSnapshot_(env) {
  const sheetResult = await legacyFetchJson_(env, {action:"getSheets"});
  if (!sheetResult?.ok || !Array.isArray(sheetResult.sheets) || !sheetResult.sheets.length) {
    throw new Error("Legacy bridge returned no sheets");
  }

  const allowedTeams = parseAllowlist(env.ALLOWED_TEAMS);
  const teamIds = sheetResult.sheets
    .map(x => String(x || "").trim())
    .filter(Boolean)
    .filter(x => !allowedTeams.length || allowedTeams.includes(x));
  const teams = await Promise.all(teamIds.map(async teamId => {
    const result = await legacyFetchJson_(env, {action:"getPlaces", sheet:teamId});
    if (!result?.ok || !Array.isArray(result.places)) {
      throw new Error("Legacy getPlaces failed for " + teamId);
    }
    const stores = result.places.map(place => {
      const lat = Number(place?.lat);
      const lng = Number(place?.lng);
      const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
      return {
        id:String(place?.id ?? ""),
        name:String(place?.name ?? ""),
        locationRaw:hasLocation ? (lat + "," + lng) : "",
        mapsUrl:String(place?.mapsUrl ?? ""),
        visited:Boolean(place?.visited),
        account:String(place?.account ?? ""),
        number:String(place?.number ?? ""),
        account_name:String(place?.account_name ?? place?.accountName ?? ""),
        lastVisitedDate:String(place?.lastVisitedDate ?? ""),
        route:String(place?.route ?? ""),
        noted:String(place?.noted ?? ""),
      };
    }).filter(store => store.id && store.name);
    return {teamId, name:teamId, stores};
  }));

  const accounts = parseAllowlist(env.ALLOWED_REPORT_ACCOUNTS);
  const reportConfigSets = await Promise.all(accounts.map(async account => {
    const result = await legacyFetchJson_(env, {action:"getReportConfig", account});
    if (!result?.ok || !Array.isArray(result.items)) {
      throw new Error("Legacy getReportConfig failed for " + account);
    }
    return {account, items:result.items};
  }));

  return {
    complete:true,
    generatedAt:new Date().toISOString(),
    teams,
    reportConfigSets,
  };
}

async function legacyFetchJson_(env, query, init = {}) {
  const url = new URL(String(env.LEGACY_API_URL || ""));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.BRIDGE_TIMEOUT_MS || 45000));
  try {
    const res = await fetch(url.toString(), {
      redirect:"follow",
      ...init,
      signal:controller.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error("Legacy bridge returned invalid JSON"); }
    if (!res.ok) throw new Error("Legacy bridge HTTP " + res.status);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateSheetShadow(env, job, params) {
  const field = outboxField_(job.action);
  const target = String(params.targetVersion || "");
  if (!target) return;
  if (field === "reportConfig") {
    await env.DB.prepare("UPDATE report_config_sets SET sheet_version=? WHERE account=? AND version=?")
      .bind(target, job.account, target).run();
  } else if (field === "visit" && job.action === "resetVisitedAll") {
    await env.DB.prepare("UPDATE stores SET sheet_visit_version=? WHERE team_id=? AND visit_version=?")
      .bind(target, job.team_id, target).run();
  } else if (field && job.team_id && job.store_id) {
    const col = {noted:"sheet_noted_version",route:"sheet_route_version",location:"sheet_location_version",visit:"sheet_visit_version"}[field];
    const versionCol = {noted:"noted_version",route:"route_version",location:"location_version",visit:"visit_version"}[field];
    await env.DB.prepare(`UPDATE stores SET ${col}=? WHERE team_id=? AND store_id=? AND ${versionCol}=?`)
      .bind(target, job.team_id, job.store_id, target).run();
  }
}

async function backendStatus(env) {
  const [teams, stores, outbox] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM teams WHERE active=1").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM stores WHERE source_active=1").first(),
    env.DB.prepare(
      "SELECT status,COUNT(*) AS n FROM sync_outbox GROUP BY status ORDER BY status"
    ).all(),
  ]);
  return json({
    ok: true,
    teams: Number(teams?.n || 0),
    stores: Number(stores?.n || 0),
    outbox: Object.fromEntries((outbox.results || []).map(x => [x.status, Number(x.n)])),
  });
}

function outboxField_(action) {
  if (action === "saveNoted") return "noted";
  if (action === "updateRoute") return "route";
  if (action === "updateLocation") return "location";
  if (action === "markVisited" || action === "resetVisitedAll") return "visit";
  if (action === "saveReportConfigBulk") return "reportConfig";
  return "";
}

function storeFieldKey_(teamId, storeId, field) {
  return String(teamId) + "\u0000" + String(storeId || "*") + "\u0000" + field;
}

function sheetBool_(value) {
  if (value === true || value === 1) return 1;
  const s = String(value ?? "").trim().toLowerCase();
  return ["1","true","yes","y","done","visited"].includes(s) ? 1 : 0;
}

function canonicalMaster_(store) {
  return JSON.stringify({
    name:String(store.name || ""),
    maps:String(store.mapsUrl || ""),
    account:String(store.account || ""),
    number:String(store.number || ""),
    accountName:String(store.account_name || ""),
  });
}

function sameMaster_(existing, store) {
  return existing &&
    String(existing.name || "") === String(store.name || "") &&
    String(existing.maps_url || "") === String(store.mapsUrl || "") &&
    String(existing.account || "") === String(store.account || "") &&
    String(existing.number || "") === String(store.number || "") &&
    String(existing.account_name || "") === String(store.account_name || "");
}

async function handleSheetSnapshot(request, env) {
  if (request.method !== "POST") return json({ok:false,error:"Method not allowed"},405);
  if (!env.SHEET_SYNC_SECRET) return json({ok:false,error:"SHEET_SYNC_NOT_CONFIGURED"},503);
  if (!env.DB) return json({ok:false,error:"D1_NOT_CONFIGURED"},503);

  const body = await parseJsonBody(request);
  await verifyInboundEnvelope(body, env.SHEET_SYNC_SECRET);
  const nonceNow = new Date();
  const nonceExpiry = new Date(nonceNow.getTime() + 300000).toISOString();
  // Durable replay fence; cache is intentionally not trusted for this path.
  await env.DB.prepare("DELETE FROM inbound_nonces WHERE expires_at<=?").bind(nonceNow.toISOString()).run();
  const nonceInsert = await env.DB.prepare(
    "INSERT OR IGNORE INTO inbound_nonces(nonce,expires_at,received_at) VALUES(?,?,?)"
  ).bind(String(body.nonce), nonceExpiry, nonceNow.toISOString()).run();
  if (Number(nonceInsert?.meta?.changes || 0) !== 1) throw new HttpError(409,"REPLAYED_SHEET_NONCE");
  const eventId = String(body.eventId || "").trim();
  const payload = body.payload || {};
  if (!eventId) throw new HttpError(400,"BAD_REQUEST","Missing eventId");
  if (payload.complete !== true) throw new HttpError(400,"BAD_REQUEST","Snapshot must be complete");

  const prior = await env.DB.prepare(
    "SELECT event_id FROM sheet_inbound_events WHERE event_id=?"
  ).bind(eventId).first();
  if (prior) return json({ok:true,duplicate:true,eventId});

  const generatedAt = String(payload.generatedAt || "");
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    throw new HttpError(400,"BAD_REQUEST","Invalid snapshot generatedAt");
  }
  const latestSnapshot = await env.DB.prepare(
    "SELECT payload_json FROM sheet_inbound_events ORDER BY received_at DESC LIMIT 1"
  ).first();
  if (latestSnapshot?.payload_json) {
    try {
      const latest = JSON.parse(latestSnapshot.payload_json);
      const latestMs = Date.parse(String(latest.generatedAt || ""));
      if (Number.isFinite(latestMs) && generatedAtMs <= latestMs) {
        return json({ok:true,stale:true,eventId,generatedAt,latestGeneratedAt:latest.generatedAt});
      }
    } catch {}
  }

  const teamsInput = Array.isArray(payload.teams) ? payload.teams : [];
  const configInput = Array.isArray(payload.reportConfigSets) ? payload.reportConfigSets : [];
  if (!teamsInput.length || teamsInput.length > 20) {
    throw new HttpError(400,"BAD_REQUEST","Invalid teams snapshot");
  }
  const scopedTeams = parseAllowlist(env.ALLOWED_TEAMS);
  if (scopedTeams.length && teamsInput.some(t => !scopedTeams.includes(String(t.teamId || t.sheet || "").trim()))) {
    throw new HttpError(403,"SCOPE_FORBIDDEN","Snapshot includes a team outside the allowed production scope");
  }
  const scopedAccounts = parseAllowlist(env.ALLOWED_REPORT_ACCOUNTS);
  if (scopedAccounts.length && configInput.some(s => !scopedAccounts.includes(String(s.account || "").trim()))) {
    throw new HttpError(403,"SCOPE_FORBIDDEN","Snapshot includes a report account outside the allowed production scope");
  }

  const now = new Date().toISOString();
  const [existingStoresResult, existingConfigResult, unresolvedResult] = await Promise.all([
    env.DB.prepare(
      `SELECT team_id,store_id,name,location_raw,lat,lng,maps_url,account,number,account_name,
              noted,route,visited,last_visited_date,master_version,noted_version,route_version,
              sheet_noted_version,sheet_route_version,sheet_location_version,sheet_visit_version,
              location_version,visit_version,source_active,updated_at
         FROM stores`
    ).all(),
    env.DB.prepare("SELECT account,items_json,version,sheet_version,updated_at FROM report_config_sets").all(),
    env.DB.prepare(
      `SELECT id,action,team_id,store_id,account,status,last_error
         FROM sync_outbox WHERE status!='done'`
    ).all(),
  ]);

  const existingStores = new Map(
    (existingStoresResult.results || []).map(r => [String(r.team_id)+"\u0000"+String(r.store_id), r])
  );
  const existingConfigs = new Map(
    (existingConfigResult.results || []).map(r => [String(r.account), r])
  );

  const blockers = new Set();
  const configBlockers = new Set();
  const supersedeIds = [];
  const deadConflictJobs = new Map();
  for (const row of unresolvedResult.results || []) {
    const field = outboxField_(row.action);
    const sheetReconciles = row.status === "dead" &&
      ["VERSION_CONFLICT","INDETERMINATE_REQUIRES_RECONCILIATION"].includes(String(row.last_error || ""));
    if (sheetReconciles) {
      const key = field === "reportConfig" ? "report\u0000" + String(row.account || "") :
        storeFieldKey_(row.team_id, row.action === "resetVisitedAll" ? "*" : row.store_id, field);
      if (!deadConflictJobs.has(key)) deadConflictJobs.set(key, []);
      deadConflictJobs.get(key).push(Number(row.id));
      continue;
    }
    if (field === "reportConfig") {
      if (row.account) configBlockers.add(String(row.account));
      continue;
    }
    if (!field || !row.team_id) continue;
    if (row.action === "resetVisitedAll") {
      blockers.add(storeFieldKey_(row.team_id, "*", "visit"));
    } else {
      blockers.add(storeFieldKey_(row.team_id, row.store_id, field));
    }
  }

  const normalizedTeams = [];
  const normalizedByTeam = new Map();
  let storeCount = 0;
  for (const team of teamsInput) {
    const teamId = String(team.teamId || team.sheet || "").trim();
    if (!teamId) throw new HttpError(400,"BAD_REQUEST","Missing teamId");
    const stores = Array.isArray(team.stores) ? team.stores : [];
    if (stores.length > 5000) throw new HttpError(400,"BAD_REQUEST","Too many stores");
    const seen = new Set();
    const normalized = [];

    for (const raw of stores) {
      const id = String(raw.id || raw.storeId || "").trim();
      const name = String(raw.name || "").trim();
      if (!id || !name || seen.has(id)) {
        throw new HttpError(400,"BAD_REQUEST","Invalid or duplicate store id");
      }
      seen.add(id);
      const key = teamId+"\u0000"+id;
      const old = existingStores.get(key);

      const sheetLocationRaw = String(raw.locationRaw ?? raw.location ?? "");
      const sheetNoted = String(raw.noted ?? "");
      const sheetRoute = String(raw.route ?? "");
      const sheetVisited = sheetBool_(raw.visited);
      const sheetLastDate = String(raw.lastVisitedDate ?? "");

      const blockNoted = blockers.has(storeFieldKey_(teamId,id,"noted"));
      const blockRoute = blockers.has(storeFieldKey_(teamId,id,"route"));
      const blockLocation = blockers.has(storeFieldKey_(teamId,id,"location"));
      const blockVisit = blockers.has(storeFieldKey_(teamId,id,"visit")) ||
        blockers.has(storeFieldKey_(teamId,"*","visit"));

      const sheetNotedVersion = await hashVersion(sheetNoted);
      const sheetRouteVersion = await hashVersion(sheetRoute);
      const sheetLocationVersion = await hashVersion(sheetLocationRaw);
      const sheetVisitVersion = await hashVersion(sheetVisited + "|" + sheetLastDate);
      const supersede = (field, changed) => {
        if (changed) supersedeIds.push(...(deadConflictJobs.get(storeFieldKey_(teamId,id,field)) || []));
      };
      // An unchanged Sheet shadow means this snapshot is merely observing an
      // unprojected D1 write; only a changed Sheet value is authoritative.
      const noted = blockNoted && old ? String(old.noted || "") : old && sheetNotedVersion === String(old.sheet_noted_version) ? String(old.noted || "") : sheetNoted;
      const route = blockRoute && old ? String(old.route || "") : old && sheetRouteVersion === String(old.sheet_route_version) ? String(old.route || "") : sheetRoute;
      const locationRaw = blockLocation && old ? String(old.location_raw || "") : old && sheetLocationVersion === String(old.sheet_location_version) ? String(old.location_raw || "") : sheetLocationRaw;
      const visited = blockVisit && old ? Number(old.visited || 0) : old && sheetVisitVersion === String(old.sheet_visit_version) ? Number(old.visited || 0) : sheetVisited;
      const lastVisitedDate = blockVisit && old ? String(old.last_visited_date || "") : old && sheetVisitVersion === String(old.sheet_visit_version) ? String(old.last_visited_date || "") : sheetLastDate;
      if (old) {
        supersede("noted", sheetNotedVersion !== String(old.sheet_noted_version));
        supersede("route", sheetRouteVersion !== String(old.sheet_route_version));
        supersede("location", sheetLocationVersion !== String(old.sheet_location_version));
        supersede("visit", sheetVisitVersion !== String(old.sheet_visit_version));
        if (sheetVisitVersion !== String(old.sheet_visit_version)) supersedeIds.push(...(deadConflictJobs.get(storeFieldKey_(teamId,"*","visit")) || []));
      }
      const loc = parseLocation(locationRaw);

      const notedVersion = old && String(old.noted || "") === noted
        ? String(old.noted_version) : await hashVersion(noted);
      const routeVersion = old && String(old.route || "") === route
        ? String(old.route_version) : await hashVersion(route);
      const locationVersion = old && String(old.location_raw || "") === locationRaw
        ? String(old.location_version) : await hashVersion(locationRaw);
      const visitRaw = visited + "|" + lastVisitedDate;
      const oldVisitRaw = old ? Number(old.visited || 0) + "|" + String(old.last_visited_date || "") : null;
      const visitVersion = old && oldVisitRaw === visitRaw
        ? String(old.visit_version) : await hashVersion(visitRaw);

      const masterSource = {
        name,
        mapsUrl:String(raw.mapsUrl ?? ""),
        account:String(raw.account ?? ""),
        number:String(raw.number ?? ""),
        account_name:String(raw.account_name ?? raw.accountName ?? ""),
      };
      const masterVersion = sameMaster_(old, masterSource)
        ? String(old.master_version)
        : await hashVersion(canonicalMaster_(masterSource));

      const unchanged = old &&
        sameMaster_(old, masterSource) &&
        String(old.noted || "") === noted &&
        String(old.route || "") === route &&
        String(old.location_raw || "") === locationRaw &&
        Number(old.visited || 0) === visited &&
        String(old.last_visited_date || "") === lastVisitedDate &&
        Number(old.source_active || 0) === 1;

      normalized.push({
        team_id:teamId, store_id:id, name,
        location_raw:locationRaw, lat:loc.lat, lng:loc.lng,
        maps_url:masterSource.mapsUrl, account:masterSource.account,
        number:masterSource.number, account_name:masterSource.account_name,
        noted, route, visited, last_visited_date:lastVisitedDate,
        master_version:masterVersion, noted_version:notedVersion,
        route_version:routeVersion, location_version:locationVersion,
        visit_version:visitVersion, source_active:1,
        sheet_noted_version: blockNoted && old ? String(old.sheet_noted_version) : sheetNotedVersion,
        sheet_route_version: blockRoute && old ? String(old.sheet_route_version) : sheetRouteVersion,
        sheet_location_version: blockLocation && old ? String(old.sheet_location_version) : sheetLocationVersion,
        sheet_visit_version: blockVisit && old ? String(old.sheet_visit_version) : sheetVisitVersion,
        updated_at:unchanged ? String(old.updated_at || now) : now,
      });
    }

    normalizedTeams.push({team_id:teamId,name:String(team.name || teamId),source_sheet:teamId,active:1,updated_at:now});
    normalizedByTeam.set(teamId, normalized);
    storeCount += normalized.length;
  }

  const normalizedConfig = [];
  let configItemCount = 0;
  const snapshotAccounts = new Set();
  for (const set of configInput) {
    const account = String(set.account || "").trim();
    if (!account || snapshotAccounts.has(account)) {
      throw new HttpError(400,"BAD_REQUEST","Invalid or duplicate report config account");
    }
    snapshotAccounts.add(account);
    if (configBlockers.has(account)) {
      const old = existingConfigs.get(account);
      if (old) normalizedConfig.push({
        account, items_json:String(old.items_json || "[]"),
        version:String(old.version || ""), sheet_version:String(old.sheet_version || ""), updated_at:String(old.updated_at || now),
      });
      continue;
    }
    const items = (Array.isArray(set.items) ? set.items : []).map(item => ({
      account,
      kind:String(item.kind || "").trim(),
      id:String(item.id || "").trim(),
      sort:Number(item.sort || 0),
      active:item.active !== false,
      data:item.data ?? {},
      updatedAt:String(item.updatedAt || ""),
    })).filter(x => x.kind && x.id)
      .sort((a,b)=>a.sort-b.sort || a.id.localeCompare(b.id));
    const itemsJson = JSON.stringify(items);
    const old = existingConfigs.get(account);
    const sheetVersion = await hashVersion(itemsJson);
    const preserveD1 = old && sheetVersion === String(old.sheet_version || "");
    if (old && !preserveD1) supersedeIds.push(...(deadConflictJobs.get("report\u0000" + account) || []));
    const version = preserveD1
      ? String(old.version) : await hashVersion(itemsJson);
    normalizedConfig.push({
      account, items_json:preserveD1 ? String(old.items_json) : itemsJson, version,
      sheet_version:sheetVersion,
      updated_at:preserveD1 ? String(old.updated_at || now) : now,
    });
    configItemCount += items.length;
  }

  const deleteAccounts = [...existingConfigs.keys()].filter(a =>
    !snapshotAccounts.has(a) && !configBlockers.has(a)
  );

  const statements = [];
  const teamsJson = JSON.stringify(normalizedTeams);
  statements.push(env.DB.prepare(
    `UPDATE teams
        SET active=0,updated_at=?
      WHERE active=1
        AND team_id NOT IN (
          SELECT json_extract(value,'$.team_id') FROM json_each(?)
        )`
  ).bind(now, teamsJson));
  statements.push(env.DB.prepare(
    `INSERT INTO teams(team_id,name,source_sheet,active,updated_at)
     SELECT json_extract(value,'$.team_id'),json_extract(value,'$.name'),
            json_extract(value,'$.source_sheet'),1,json_extract(value,'$.updated_at')
       FROM json_each(?)
      WHERE true
     ON CONFLICT(team_id) DO UPDATE SET
       name=excluded.name,source_sheet=excluded.source_sheet,active=1,updated_at=excluded.updated_at
     WHERE teams.name IS NOT excluded.name
        OR teams.source_sheet IS NOT excluded.source_sheet
        OR teams.active IS NOT 1`
  ).bind(teamsJson));

  for (const team of normalizedTeams) {
    const storesJson = JSON.stringify(normalizedByTeam.get(team.team_id) || []);
    statements.push(env.DB.prepare(
      `UPDATE stores
          SET source_active=0,updated_at=?
        WHERE team_id=? AND source_active=1
          AND store_id NOT IN (
            SELECT json_extract(value,'$.store_id') FROM json_each(?)
          )`
    ).bind(now, team.team_id, storesJson));
    statements.push(env.DB.prepare(
      `INSERT INTO stores(
        team_id,store_id,name,location_raw,lat,lng,maps_url,account,number,account_name,
        noted,route,visited,last_visited_date,master_version,noted_version,route_version,
        location_version,visit_version,sheet_noted_version,sheet_route_version,sheet_location_version,sheet_visit_version,source_active,updated_at)
       SELECT
        json_extract(value,'$.team_id'),json_extract(value,'$.store_id'),json_extract(value,'$.name'),
        json_extract(value,'$.location_raw'),json_extract(value,'$.lat'),json_extract(value,'$.lng'),
        json_extract(value,'$.maps_url'),json_extract(value,'$.account'),json_extract(value,'$.number'),
        json_extract(value,'$.account_name'),json_extract(value,'$.noted'),json_extract(value,'$.route'),
        json_extract(value,'$.visited'),json_extract(value,'$.last_visited_date'),
        json_extract(value,'$.master_version'),json_extract(value,'$.noted_version'),
        json_extract(value,'$.route_version'),json_extract(value,'$.location_version'),
        json_extract(value,'$.visit_version'),json_extract(value,'$.sheet_noted_version'),
        json_extract(value,'$.sheet_route_version'),json_extract(value,'$.sheet_location_version'),
        json_extract(value,'$.sheet_visit_version'),1,json_extract(value,'$.updated_at')
       FROM json_each(?)
       WHERE true
       ON CONFLICT(team_id,store_id) DO UPDATE SET
        name=excluded.name,location_raw=excluded.location_raw,lat=excluded.lat,lng=excluded.lng,
        maps_url=excluded.maps_url,account=excluded.account,number=excluded.number,
        account_name=excluded.account_name,noted=excluded.noted,route=excluded.route,
        visited=excluded.visited,last_visited_date=excluded.last_visited_date,
        master_version=excluded.master_version,noted_version=excluded.noted_version,
        route_version=excluded.route_version,location_version=excluded.location_version,
        visit_version=excluded.visit_version,sheet_noted_version=excluded.sheet_noted_version,
        sheet_route_version=excluded.sheet_route_version,sheet_location_version=excluded.sheet_location_version,
        sheet_visit_version=excluded.sheet_visit_version,source_active=1,updated_at=excluded.updated_at
       WHERE stores.master_version IS NOT excluded.master_version
          OR stores.noted_version IS NOT excluded.noted_version
          OR stores.route_version IS NOT excluded.route_version
          OR stores.location_version IS NOT excluded.location_version
          OR stores.visit_version IS NOT excluded.visit_version
          OR stores.sheet_noted_version IS NOT excluded.sheet_noted_version
          OR stores.sheet_route_version IS NOT excluded.sheet_route_version
          OR stores.sheet_location_version IS NOT excluded.sheet_location_version
          OR stores.sheet_visit_version IS NOT excluded.sheet_visit_version
          OR stores.source_active IS NOT excluded.source_active`
    ).bind(storesJson));
  }

  if (deleteAccounts.length) {
    statements.push(env.DB.prepare(
      "DELETE FROM report_config_sets WHERE account IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(deleteAccounts)));
  }
  if (normalizedConfig.length) {
    statements.push(env.DB.prepare(
      `INSERT INTO report_config_sets(account,items_json,version,sheet_version,updated_at)
       SELECT json_extract(value,'$.account'),json_extract(value,'$.items_json'),
              json_extract(value,'$.version'),json_extract(value,'$.sheet_version'),json_extract(value,'$.updated_at')
         FROM json_each(?)
        WHERE true
       ON CONFLICT(account) DO UPDATE SET
        items_json=excluded.items_json,version=excluded.version,sheet_version=excluded.sheet_version,updated_at=excluded.updated_at
       WHERE report_config_sets.items_json IS NOT excluded.items_json
          OR report_config_sets.version IS NOT excluded.version
          OR report_config_sets.sheet_version IS NOT excluded.sheet_version`
    ).bind(JSON.stringify(normalizedConfig)));
  }

  const uniqueSupersedeIds = [...new Set(supersedeIds)];
  if (uniqueSupersedeIds.length) {
    statements.push(env.DB.prepare(
      `UPDATE sync_outbox
          SET status='done',last_error='SUPERSEDED_BY_SHEET',updated_at=?
        WHERE id IN (SELECT value FROM json_each(?))`
    ).bind(now, JSON.stringify(uniqueSupersedeIds)));
  }

  const summary = {
    complete:true, generatedAt:String(payload.generatedAt || ""),
    teams:normalizedTeams.length, stores:storeCount,
    configAccounts:normalizedConfig.length, configItems:configItemCount,
    superseded:uniqueSupersedeIds.length,
  };
  statements.push(env.DB.prepare(
    "INSERT INTO sheet_inbound_events(event_id,payload_json,received_at) VALUES(?,?,?)"
  ).bind(eventId, JSON.stringify(summary), now));
  statements.push(env.DB.prepare(
    `INSERT INTO audit_events(event_type,origin,request_id,payload_json,created_at)
     VALUES('sheet_snapshot','sheet_manual',?,?,?)`
  ).bind(eventId, JSON.stringify(summary), now));

  await env.DB.batch(statements);
  return json({ok:true,eventId,...summary});
}

async function verifyInboundEnvelope(body, secret) {
  const ts = Number(body.ts || 0);
  const nonce = String(body.nonce || "");
  const signature = String(body.signature || "");
  if (!ts || !nonce || !signature) throw new HttpError(401,"INVALID_SHEET_SIGNATURE");
  if (Math.abs(Date.now()-ts) > 300000) throw new HttpError(401,"EXPIRED_SHEET_SIGNATURE");
  const canonical = JSON.stringify({
    method:"POST",
    path:"/internal/sheet-snapshot",
    eventId:String(body.eventId || ""),
    payload:body.payload || {},
    ts,
    nonce,
  });
  const expected = await hmacBase64Url(secret, canonical);
  if (!safeEqual(expected, signature)) throw new HttpError(401,"INVALID_SHEET_SIGNATURE");
}

async function handleUserSession(env) {
  if (!env.SESSION_SECRET) {
    return json({ok:false,error:"SESSION_AUTH_NOT_CONFIGURED"},503);
  }
  return issueSession_("user", env);
}

async function handleLogin(request, env) {
  if (!env.SESSION_SECRET || !env.ADMIN_ACCESS_CODE) {
    return json({ok:false,error:"SESSION_AUTH_NOT_CONFIGURED"},503);
  }
  const rate = await readLoginRate_(request, env);
  if (rate.blocked) {
    return json({ok:false,error:"LOGIN_RATE_LIMITED"},429);
  }

  const body = await parseJsonBody(request);
  const code = String(body.code || "").trim();
  if (!code) throw new HttpError(400,"BAD_REQUEST","Missing access code");

  if (!safeEqual(code, String(env.ADMIN_ACCESS_CODE))) {
    await recordFailedLogin_(rate, env);
    return json({ok:false,error:"INVALID_ACCESS_CODE"},403);
  }

  await clearLoginRate_(rate, env);
  return issueSession_("admin", env);
}

async function issueSession_(role, env) {
  const ttl = Math.max(900, Math.min(86400, Number(env.SESSION_TTL_SEC || 43200)));
  const now = Math.floor(Date.now()/1000);
  const payload = {v:1,role,iat:now,exp:now+ttl,jti:crypto.randomUUID()};
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacBase64Url(env.SESSION_SECRET, "pt1." + encoded);
  return json({
    ok:true,
    role,
    token:"pt1." + encoded + "." + signature,
    expiresAt:new Date((now+ttl)*1000).toISOString(),
  });
}

async function readLoginRate_(request, env) {
  if (!env.DB || !env.SESSION_SECRET) return {key:"",blocked:false,attempts:0,windowStart:0};
  const ip = String(request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const key = (await hmacBase64Url(env.SESSION_SECRET, "login-rate:" + ip)).slice(0,40);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  await env.DB.prepare("DELETE FROM auth_login_attempts WHERE updated_at<?")
    .bind(new Date(now - 24*60*60*1000).toISOString()).run();
  const row = await env.DB.prepare("SELECT window_start,attempts FROM auth_login_attempts WHERE key=?").bind(key).first();
  if (!row || now - Number(row.window_start || 0) >= windowMs) {
    return {key,blocked:false,attempts:0,windowStart:now};
  }
  const attempts = Number(row.attempts || 0);
  return {key,blocked:attempts >= 10,attempts,windowStart:Number(row.window_start || now)};
}

async function recordFailedLogin_(rate, env) {
  if (!env.DB || !rate?.key) return;
  const now = Date.now();
  const windowStart = Number(rate.windowStart || now);
  const attempts = Number(rate.attempts || 0) + 1;
  await env.DB.prepare(`
    INSERT INTO auth_login_attempts(key,window_start,attempts,updated_at)
    VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET
      window_start=excluded.window_start,
      attempts=excluded.attempts,
      updated_at=excluded.updated_at
  `).bind(rate.key, windowStart, attempts, new Date(now).toISOString()).run();
}

async function clearLoginRate_(rate, env) {
  if (!env.DB || !rate?.key) return;
  await env.DB.prepare("DELETE FROM auth_login_attempts WHERE key=?").bind(rate.key).run();
}

async function authorize(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return { ok:false,status:401,error:"Unauthorized" };
  const token = header.slice(7).trim();

  if (env.SERVICE_API_TOKEN && safeEqual(token, String(env.SERVICE_API_TOKEN))) {
    return {ok:true,role:"service"};
  }
  if (!env.SESSION_SECRET) {
    return env.SERVICE_API_TOKEN
      ? {ok:false,status:403,error:"Forbidden"}
      : {ok:false,status:503,error:"API authentication is not configured"};
  }

  const verified = await verifySessionToken(token, env.SESSION_SECRET);
  if (!verified) return {ok:false,status:403,error:"Forbidden"};
  return {ok:true,role:verified.role,expiresAt:new Date(verified.exp*1000).toISOString()};
}

async function verifySessionToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "pt1") return null;
  const expected = await hmacBase64Url(secret, "pt1." + parts[1]);
  if (!safeEqual(expected, parts[2])) return null;
  let payload;
  try {
    let raw = parts[1].replace(/-/g,"+").replace(/_/g,"/");
    raw += "=".repeat((4 - raw.length % 4) % 4);
    const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || !["user","admin"].includes(String(payload.role || ""))) return null;
  const now = Math.floor(Date.now()/1000);
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) return null;
  return payload;
}

function enforceScope(env, route) {
  const teams = parseAllowlist(env.ALLOWED_TEAMS);
  const accounts = parseAllowlist(env.ALLOWED_REPORT_ACCOUNTS);
  if (route.teamId && teams.length && !teams.includes(String(route.teamId))) {
    throw new HttpError(403,"SCOPE_FORBIDDEN","Team is outside the allowed service-token scope");
  }
  if (route.account && accounts.length && !accounts.includes(String(route.account))) {
    throw new HttpError(403,"SCOPE_FORBIDDEN","Report account is outside the allowed service-token scope");
  }
}
function parseAllowlist(raw) { return String(raw || "").split(",").map(x=>x.trim()).filter(Boolean); }

function requireIdempotencyKey(request) {
  const id = String(request.headers.get("Idempotency-Key") || "").trim();
  // Projection jobs add a prefix before forwarding the key to Apps Script,
  // whose bridge contract caps requestId at 128 characters.
  if (!id || id.length > 96) throw new HttpError(400,"BAD_REQUEST","Missing or invalid Idempotency-Key");
  return id;
}
function requireBaseVersion(body) {
  if (body.baseVersion === null || body.baseVersion === undefined || body.baseVersion === "") {
    throw new HttpError(400,"BAD_REQUEST","Missing baseVersion");
  }
  return String(body.baseVersion);
}

async function parseJsonBody(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new HttpError(400,"BAD_REQUEST","Content-Type must be application/json");
  }
  const text = await request.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new HttpError(400,"BAD_REQUEST","Invalid JSON body"); }
}

async function hashVersion(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return base64Url(digest).slice(0,32);
}
async function hmacBase64Url(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return base64Url(sig);
}
function base64Url(bytes) {
  let binary="";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function safeEqual(a,b) {
  a=String(a||""); b=String(b||"");
  let diff=a.length^b.length;
  const n=Math.max(a.length,b.length,1);
  for(let i=0;i<n;i++) diff|=(a.charCodeAt(i%Math.max(a.length,1))||0)^(b.charCodeAt(i%Math.max(b.length,1))||0);
  return diff===0;
}
function bangkokDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date());
  const m=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function parseLocation(raw) {
  const m=String(raw||"").match(/-?\d+(?:\.\d+)?/g);
  if(!m||m.length<2) return {lat:null,lng:null};
  const lat=Number(m[0]),lng=Number(m[1]);
  return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:{lat:null,lng:null};
}
function farFuture() { return "9999-12-31T23:59:59.999Z"; }
function quoteEtag(v) { return '"' + String(v).replace(/"/g,"") + '"'; }
function decode(v) { try{return decodeURIComponent(v)}catch{return v} }

function json(data,status=200,extraHeaders={}) {
  return new Response(JSON.stringify(data),{
    status,
    headers:{...JSON_HEADERS,...extraHeaders},
  });
}
function preflight(request,env) {
  const origin=request.headers.get("Origin");
  if(!origin||!allowedOrigin(origin,env)) return new Response(null,{status:403});
  return new Response(null,{status:204,headers:corsHeaders(origin)});
}
function withCors(response,request,env) {
  const origin=request.headers.get("Origin");
  if(!origin||!allowedOrigin(origin,env)) return response;
  const headers=new Headers(response.headers);
  for(const [k,v] of Object.entries(corsHeaders(origin))) headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
}
function allowedOrigin(origin,env) {
  return String(env.ALLOWED_ORIGINS||"").split(",").map(v=>v.trim()).filter(Boolean).includes(origin);
}
function corsHeaders(origin) {
  return {
    "access-control-allow-origin":origin,
    "access-control-allow-methods":"GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":"authorization,content-type,idempotency-key",
    "access-control-max-age":"600",
    "vary":"Origin",
  };
}
