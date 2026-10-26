import assert from "node:assert/strict";
import {createHash,createHmac,randomUUID} from "node:crypto";
import worker from "../src/index.js";

const digest=v=>createHash("sha256").update(String(v)).digest("base64url").slice(0,32);
const now=Date.now();
const ts=mins=>new Date(now-mins*60000).toISOString();
const common={team_id:"TEAM",store_id:"S1",name:"Store",location_raw:"13.7,100.5",
 lat:13.7,lng:100.5,maps_url:"",account:"LAWSON",number:"1",account_name:"Test",
 noted:"D1 note",route:"R2",visited:1,last_visited_date:"2026-10-26",
 source_active:1,updated_at:ts(2),
 master_version:digest(JSON.stringify({name:"Store",maps:"",account:"LAWSON",number:"1",accountName:"Test"})),
 noted_version:digest("D1 note"),route_version:digest("R2"),
 location_version:digest("13.7,100.5"),visit_version:digest("1|2026-10-26"),
 sheet_noted_version:digest("Old note"),sheet_route_version:digest("R1"),
 sheet_location_version:digest("13.7,100.5"),sheet_visit_version:digest("0|2026-10-25"),
};
const old={id:"S1",name:"Store",locationRaw:"13.7,100.5",mapsUrl:"",
 account:"LAWSON",number:"1",account_name:"Test",noted:"Old note",route:"R1",
 visited:false,lastVisitedDate:"2026-10-25"};
const job=(field,time,id)=>({
 id,action:({noted:"saveNoted",route:"updateRoute",visit:"markVisited"})[field],
 team_id:"TEAM",store_id:"S1",status:"pending",created_at:time,last_error:null
});
async function execute(store, jobs, tracker={}){
 const writes=[],reads=[],m={...old,...store,fieldMeta:tracker};
 const payload={complete:true,generatedAt:ts(0),
 teams:[{teamId:"TEAM",name:"TEAM",stores:[m]}],reportConfigSets:[],forceReconciliation:true};
 const db={prepare(sql){
   const st={sql,args:[],bind(...args){this.args=args;return this},
    async first(){reads.push(sql);if(sql.includes("SELECT payload_json FROM sheet_inbound_events"))
       return {payload_json:JSON.stringify({generatedAt:ts(60),snapshotHash:"old"})};
      return null;},
    async all(){reads.push(sql);
      if(sql.includes("FROM stores"))return {results:[common]};
      if(sql.includes("FROM sync_outbox"))return {results:jobs};
      return {results:[]};},
    async run(){reads.push(sql);return {meta:{changes:1}};
   }};return st;},
   async batch(stmts){writes.push(...stmts);return stmts.map(()=>({meta:{changes:1}}))}
 };
 const body={method:"POST",path:"/internal/sheet-snapshot",
  eventId:randomUUID(),payload,ts:Date.now(),nonce:randomUUID()};
 body.signature=createHmac("sha256","sheet-secret").update(JSON.stringify(body)).digest("base64url");
 const r=await worker.fetch(new Request("https://worker.test/internal/sheet-snapshot",{
   method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify(body)
 }),{DB:db,SHEET_SYNC_SECRET:"sheet-secret",ALLOWED_TEAMS:"TEAM",ALLOWED_REPORT_ACCOUNTS:"LAWSON"},{waitUntil(){}});
 assert.equal(r.status,200,await r.clone().text());
 const result=await r.json();
 const changed=writes.find(x=>x.sql.includes("INSERT INTO stores"));
 const merged=changed && JSON.parse(changed.args[0])[0];
 return {result,writes,merged};
}
{
 const {result,merged,writes}=await execute({route:"R3"},[
  job("noted",ts(3),101),job("visit",ts(2),102)
 ]);
 assert.equal(result.conflicts,0,"different fields of the same store must not conflict");
 assert.equal(merged.route,"R3","Sheet route must merge");
 assert.equal(merged.noted,"D1 note","D1 note must remain");
 assert.equal(merged.visited,1,"D1 visit must remain");
 assert.equal(merged.last_visited_date,"2026-10-26");
 assert.equal(writes.filter(x=>x.sql.includes("CONCURRENT_SHEET_EDIT")).length,0);
}
{
 const routeMeta={route:{version:digest("R3"),changedAt:ts(1)}};
 const {result,merged,writes}=await execute({route:"R3"},[job("route",ts(5),103)],routeMeta);
 assert.equal(result.conflicts,0);
 assert.equal(result.lwwResolved,1);
 assert.equal(merged.route,"R3","newer Sheet edit wins");
 assert.ok(writes.find(x=>x.sql.includes("SUPERSEDED_BY_NEWER_FIELD")));
 assert.ok(writes.find(x=>x.sql.includes("VALUES('field_lww'")));
}
{
 const {result,merged,writes}=await execute({route:"R3"},[job("route",ts(1),104)],
   {route:{version:digest("R3"),changedAt:ts(5)}});
 assert.equal(result.conflicts,0);
 assert.equal(result.lwwResolved,1);
 assert.equal(merged,undefined,"newer D1 field should not be overwritten");
 const rebased=writes.find(x=>x.sql.includes("json_set(payload_json"));
 assert.ok(rebased,"newest local operation must be rebased to current Sheet version");
 assert.equal(rebased.args[0],digest("R3"));
}
{
 const {result,writes}=await execute({route:"R3"},[job("route",ts(1),105)],{});
 assert.equal(result.conflicts,1);
 assert.ok(writes.find(x=>x.sql.includes("CONCURRENT_SHEET_EDIT")));
}
console.log("field-lww-merge: ok (different fields, newer Sheets, newer D1, unverified timestamp)");
