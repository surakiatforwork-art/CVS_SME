import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {reconcileReportConfigConflicts} from "../src/index.js";

const ver=rows=>createHash("sha256").update(JSON.stringify(rows)).digest("base64url").slice(0,32);
const item=(label,time)=>({account:"CJ MORE",kind:"promotion",id:"demo",sort:1,active:true,data:{label},updatedAt:time});
const old="2026-10-19T01:18:29.043Z";
const latest="2026-11-07T08:25:35.086Z";

function fixture({sourceNewer=false,equal=false}={}){
  const db=new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE report_config_sets(account TEXT PRIMARY KEY,items_json TEXT,version TEXT,sheet_version TEXT,updated_at TEXT);
    CREATE TABLE sync_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT,account TEXT,request_id TEXT,
      payload_json TEXT,status TEXT,attempt_count INTEGER,next_attempt_at TEXT,created_at TEXT,updated_at TEXT,last_error TEXT);
    CREATE TABLE audit_events(event_type TEXT,origin TEXT,account TEXT,payload_json TEXT,created_at TEXT);
  `);
  const d1Items=[item("D1 latest",latest)];
  const sheetItems=equal?d1Items:[item("Sheets value",sourceNewer?latest:old)];
  const d1UpdatedAt=sourceNewer?old:latest;
  db.prepare("INSERT INTO report_config_sets VALUES (?,?,?,?,?)")
    .run("CJ MORE",JSON.stringify(d1Items),ver(d1Items),"old-shadow",d1UpdatedAt);
  db.prepare("INSERT INTO sync_outbox (action,account,request_id,payload_json,status,created_at) VALUES (?,?,?,?,?,?)")
    .run("saveReportConfigBulk","CJ MORE","old-request","{}","dead",old);

  const DB={
    prepare(sql){
      const statement={sql,params:[],
        bind(...p){this.params=p;return this;},
        async all(){return {results:db.prepare(sql).all(...this.params)};},
        async first(){return db.prepare(sql).get(...this.params);},
        async run(){const x=db.prepare(sql).run(...this.params);return {meta:{changes:Number(x.changes)}};},
      };
      return statement;
    },
    async batch(queries){
      db.exec("BEGIN");
      try{
        const results=queries.map(q=>({meta:{changes:Number(db.prepare(q.sql).run(...q.params).changes)}}));
        db.exec("COMMIT");
        return results;
      }catch(err){db.exec("ROLLBACK");throw err;}
    },
  };
  return {db,DB,d1Items,sheetItems,sourceNewer,equal};
}

async function run(f){
  const original=globalThis.fetch;
  globalThis.fetch=async(_,opts)=>{
    const input=JSON.parse(opts.body);
    assert.equal(input.action,"getReportConfig");
    return new Response(JSON.stringify({ok:true,account:"CJ MORE",items:f.sheetItems,version:ver(f.sheetItems)}),{status:200});
  };
  try{
    const result=await reconcileReportConfigConflicts({
      DB:f.DB,BRIDGE_URL:"https://example.test",BRIDGE_SECRET:"local-test-secret",
    });
    return result;
  }finally{globalThis.fetch=original;}
}
{
  const f=fixture(), result=await run(f);
  assert.deepEqual(result,{resolved:1,unresolved:0,projected:1});
  const rows=f.db.prepare("SELECT status,last_error,payload_json FROM sync_outbox ORDER BY id").all();
  assert.equal(rows.length,2);
  assert.equal(rows[0].status,"done");
  assert.equal(rows[0].last_error,"LWW_D1_NEWER");
  assert.equal(rows[1].status,"pending");
  assert.equal(JSON.parse(rows[1].payload_json).sheetBaseVersion,ver(f.sheetItems));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n,1);
  f.db.close();
}
{
  const f=fixture({sourceNewer:true}), result=await run(f);
  assert.deepEqual(result,{resolved:1,unresolved:0,projected:0});
  assert.equal(f.db.prepare("SELECT version FROM report_config_sets").get().version,ver(f.sheetItems));
  assert.equal(f.db.prepare("SELECT status FROM sync_outbox").get().status,"done");
  f.db.close();
}
{
  const f=fixture({equal:true}), result=await run(f);
  assert.deepEqual(result,{resolved:1,unresolved:0,projected:0});
  assert.equal(f.db.prepare("SELECT status FROM sync_outbox").get().status,"done");
  f.db.close();
}
console.log("report-config-lww-sqlite: PASS (real SQLite bindings, D1->Sheets, Sheets->D1, no-op)");
