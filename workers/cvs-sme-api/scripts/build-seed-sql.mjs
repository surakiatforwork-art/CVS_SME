import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [,, inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: node build-seed-sql.mjs <seed.json> <out.sql>");
  process.exit(2);
}

const seed = JSON.parse(readFileSync(inputPath, "utf8"));
const now = seed.generatedAt || new Date().toISOString();

function version(v) {
  return createHash("sha256").update(String(v ?? "")).digest("base64url").slice(0, 32);
}
function str(v) { return v == null ? "" : String(v).trim(); }
function sql(v) { return "'" + String(v ?? "").replaceAll("'", "''") + "'"; }
function serialDate(v) {
  if (v === "" || v == null) return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(v * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
function bool(v) {
  if (v === true || v === 1) return 1;
  const s = str(v).toLowerCase();
  return ["1","true","yes","y","done","visited"].includes(s) ? 1 : 0;
}
function parseLoc(raw) {
  const m = str(raw).match(/-?\d+(?:\.\d+)?/g);
  if (!m || m.length < 2) return {lat:null,lng:null};
  const lat=Number(m[0]), lng=Number(m[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? {lat,lng} : {lat:null,lng:null};
}
function mapRows(rows) {
  const headers=(rows[0]||[]).map(x=>str(x).toLowerCase().replace(/\s+/g,"_"));
  return rows.slice(1).map(row=>{
    const out={};
    headers.forEach((h,i)=>{ if(h) out[h]=row[i] ?? ""; });
    return out;
  });
}
function pick(o, keys) {
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(o,k)) return o[k];
  return "";
}

const stores = mapRows(seed.stores || []).filter(r => str(pick(r,["list","id"])) && str(r.name));
const cfg = mapRows(seed.reportConfig || []).filter(r => str(r.account) && str(r.kind) && str(r.id));
const accounts = new Map();
for (const r of cfg) {
  const account=str(r.account);
  if (!accounts.has(account)) accounts.set(account, []);
  let data={};
  try { data=JSON.parse(str(r.data)||"{}"); } catch {}
  accounts.get(account).push({
    account,
    kind:str(r.kind),
    id:str(r.id),
    sort:Number(r.sort)||0,
    active:bool(r.active)===1,
    data,
    updatedAt:str(r.updatedat || r.updatedAt),
  });
}
for (const items of accounts.values()) items.sort((a,b)=>a.sort-b.sort || a.id.localeCompare(b.id));

const lines=[
  "PRAGMA foreign_keys=ON;",
  "DELETE FROM report_config_sets;",
  "DELETE FROM stores;",
  "DELETE FROM teams;",
  `INSERT INTO teams(team_id,name,source_sheet,active,updated_at) VALUES(${sql(seed.teamId)},${sql(seed.teamId)},${sql(seed.teamId)},1,${sql(now)});`
];

for (const r of stores) {
  const id=str(pick(r,["list","id"]));
  const name=str(r.name);
  const locationRaw=str(pick(r,["location","latlng","lat_lng"]));
  const {lat,lng}=parseLoc(locationRaw);
  const maps=str(pick(r,["google_maps","googlemaps","google map","maps","map"]));
  const account=str(r.account);
  const number=str(pick(r,["number","branch","branch_number","store_no"]));
  const accountName=str(pick(r,["account_name","accountname","store_name","branch_name"]));
  const noted=str(r.noted);
  const route=str(pick(r,["route","rount","route_no","route_number","routeno"]));
  const visited=bool(pick(r,["visited","visit","done"]));
  const lastVisited=serialDate(pick(r,["lastvisiteddate","last_visited_date","visited_date","last_visit_date"]));
  const masterVersion=version(JSON.stringify({name,maps,account,number,accountName}));
  const notedVersion=version(noted);
  const routeVersion=version(route);
  const locationVersion=version(locationRaw);
  const visitVersion=version(visited+"|"+lastVisited);
  lines.push(
    "INSERT INTO stores(team_id,store_id,name,location_raw,lat,lng,maps_url,account,number,account_name,noted,route,visited,last_visited_date,master_version,noted_version,sheet_noted_version,route_version,sheet_route_version,location_version,sheet_location_version,visit_version,sheet_visit_version,source_active,updated_at) VALUES("+
    [sql(seed.teamId),sql(id),sql(name),sql(locationRaw),lat==null?"NULL":lat,lng==null?"NULL":lng,sql(maps),sql(account),sql(number),sql(accountName),sql(noted),sql(route),visited,sql(lastVisited),sql(masterVersion),sql(notedVersion),sql(notedVersion),sql(routeVersion),sql(routeVersion),sql(locationVersion),sql(locationVersion),sql(visitVersion),sql(visitVersion),1,sql(now)].join(",")+
    ");"
  );
}

for (const [account,items] of accounts) {
  const json=JSON.stringify(items);
  lines.push(`INSERT INTO report_config_sets(account,items_json,version,sheet_version,updated_at) VALUES(${sql(account)},${sql(json)},${sql(version(json))},${sql(version(json))},${sql(now)});`);
}
writeFileSync(outputPath, lines.join("\n"), "utf8");
console.log(JSON.stringify({stores:stores.length,accounts:accounts.size,configItems:cfg.length,sqlStatements:lines.length}));
