import assert from "node:assert/strict";
import {createHash,createHmac,randomUUID} from "node:crypto";
import worker from "../src/index.js";

const secret = "test-sheet-secret";
const ver = x=>createHash("sha256").update(String(x)).digest("base64url").slice(0,32);
const store = {
  id:"001",name:"Example",locationRaw:"13.7,100.5",mapsUrl:"",
  account:"LAWSON",number:"X",account_name:"Test",
  noted:"Sheet Edit",route:"R1",visited:false,lastVisitedDate:"",
};
const basePayload = {
  complete:true,generatedAt:"2026-10-26T03:00:00.000Z",
  teams:[{teamId:"DB_GBKK4",name:"DB_GBKK4",stores:[store]}],
  reportConfigSets:[],
};
const hash = ver(JSON.stringify({teams:basePayload.teams,reportConfigSets:basePayload.reportConfigSets}));
const dbStore={
  team_id:"DB_GBKK4",store_id:"001",name:"Example",location_raw:"13.7,100.5",
  lat:13.7,lng:100.5,maps_url:"",account:"LAWSON",number:"X",account_name:"Test",
  noted:"Local Edit",route:"R1",visited:0,last_visited_date:"",
  source_active:1,updated_at:"2026-10-25T01:00:00.000Z",
  master_version:ver(JSON.stringify({name:"Example",maps:"",account:"LAWSON",number:"X",accountName:"Test"})),
  noted_version:ver("Local Edit"),route_version:ver("R1"),
  location_version:ver("13.7,100.5"),visit_version:ver("0|"),
  sheet_noted_version:ver("Old Sheet"),sheet_route_version:ver("R1"),
  sheet_location_version:ver("13.7,100.5"),sheet_visit_version:ver("0|"),
};

function fakeDB({knownHash="",pending=false}={}){
  const statements = [];
  const seen = [];
  const DB={
    prepare(sql){
      const statement={
        sql:String(sql),args:[],
        bind(...args){this.args=args;return this;},
        async first(){
          seen.push(this.sql);
          if(this.sql.includes("SELECT payload_json FROM sheet_inbound_events"))
            return {payload_json:JSON.stringify({generatedAt:"2026-10-25T02:00:00.000Z",snapshotHash:knownHash})};
          return null;
        },
        async all(){
          seen.push(this.sql);
          if(this.sql.includes("FROM stores")) return {results:[dbStore]};
          if(this.sql.includes("FROM sync_outbox"))return {results:pending ? [{
            id:123,action:"saveNoted",team_id:"DB_GBKK4",store_id:"001",
            status:"pending",last_error:null,
          }] : []};
          return {results:[]};
        },
        async run(){
          seen.push(this.sql);
          return {meta:{changes:1}};
        },
      };return statement;
    },
    async batch(batch){
      statements.push(...batch);
      return batch.map(()=>({meta:{changes:1}}));
    },
  };
  return {DB, statements,seen};
}
async function call(envDb,force=false){
  const payload={...basePayload,forceReconciliation:force};
  const unsigned={method:"POST",path:"/internal/sheet-snapshot",
    eventId:randomUUID(),payload,ts:Date.now(),nonce:randomUUID()};
  const signature=createHmac("sha256",secret).update(JSON.stringify(unsigned)).digest("base64url");
  const response=await worker.fetch(new Request("https://worker.test/internal/sheet-snapshot", {
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({...unsigned,signature}),
  }),{DB:envDb.DB,SHEET_SYNC_SECRET:secret,ALLOWED_TEAMS:"DB_GBKK4",
    ALLOWED_REPORT_ACCOUNTS:"LAWSON"},{waitUntil(){}});
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}
{
  const d=fakeDB({knownHash:hash});
  const result=await call(d,false);
  assert.equal(result.unchanged,true);
  assert.ok(!d.seen.some(sql=>sql.includes("FROM stores")),"unchanged should skip D1 store scans");
  assert.equal(d.statements.length,0);
}
{
  const d=fakeDB({knownHash:hash});
  const result=await call(d,true);
  assert.equal(result.ok,true);
  assert.ok(d.seen.some(sql=>sql.includes("FROM stores")),"daily forced full reconciliation");
}
{
  const d=fakeDB({knownHash:"old-source",pending:true});
  const result=await call(d);
  assert.equal(result.ok,true);
  assert.equal(result.conflicts,1);
  const job=d.statements.find(st=>st.sql.includes("CONCURRENT_SHEET_EDIT"));
  assert.ok(job,"must halt outbound write on concurrent change");
  assert.deepEqual(JSON.parse(job.args[2]),[123]);
  const update=d.statements.find(st=>st.sql.includes("INSERT INTO stores"));
  if(update){
    const updated=JSON.parse(update.args[0]);
    assert.equal(updated[0].noted,"Local Edit","must preserve pending local edit");
  }
}
console.log("hourly-sync-regression: ok (no-op, daily force, two-way conflict)");
