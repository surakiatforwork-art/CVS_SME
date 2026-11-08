import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {reconcileReportConfigConflicts} from "../src/index.js";

const ver = rows => createHash("sha256").update(JSON.stringify(rows)).digest("base64url").slice(0,32);
const item = (label,updatedAt)=>({
  account:"CJ MORE",kind:"promotion",id:"p1",sort:1,active:true,data:{label},updatedAt,
});
const now="2026-11-08T00:00:00.000Z";
const old="2026-10-19T00:00:00.000Z";
const newer="2026-11-07T08:25:35.086Z";

async function scenario({d1Time=newer,sheetTime=old,same=false,legacy=false}){
  const dbItems=[item("D1 newest",newer)];
  const sheetItems=same?dbItems:[item("Sheet value",sheetTime)];
  const dbRow={account:"CJ MORE",items_json:JSON.stringify(dbItems),
    version:ver(dbItems),updated_at:d1Time};
  const batches=[];
  const DB={
    prepare(sql){
      return {
        sql,args:[],
        bind(...values){this.args=values;return this;},
        async all(){return {results:[dbRow]}},
      };
    },
    async batch(statements){
      batches.push(statements.map(x=>({sql:x.sql,args:x.args})));
      return statements.map(()=>({meta:{changes:1}}));
    }
  };
  const original=globalThis.fetch;
  globalThis.fetch=async (_url,init)=>{
    const request=JSON.parse(init.body);
    assert.equal(request.action,"getReportConfig");
    return new Response(JSON.stringify({ok:true,account:"CJ MORE",
      items:sheetItems,version:ver(sheetItems)}),{status:200});
  };
  try{
    const res=await reconcileReportConfigConflicts({
      DB,BRIDGE_URL:"https://bridge.example",BRIDGE_SECRET:"test-secret",
      ...(legacy?{LEGACY_API_URL:"https://legacy.example"}:{})
    });
    return {res,batches,version:ver(sheetItems),targetVersion:ver(dbItems)};
  }finally{globalThis.fetch=original;}
}
{
  const s=await scenario({});
  assert.deepEqual(s.res,{resolved:1,unresolved:0,projected:1});
  const insert=s.batches[0].find(x=>x.sql.includes("INSERT INTO sync_outbox"));
  assert.ok(insert,"D1 winner requires a queued projection");
  const params=JSON.parse(insert.args[2]);
  assert.equal(params.sheetBaseVersion,s.version);
  assert.equal(params.targetVersion,s.targetVersion);
  assert.ok(s.batches[0].some(x=>x.sql.includes("LWW_D1_NEWER") || x.args.includes("LWW_D1_NEWER")));
}
{
  const s=await scenario({d1Time:old,sheetTime:newer});
  assert.deepEqual(s.res,{resolved:1,unresolved:0,projected:0});
  const update=s.batches[0].find(x=>x.sql.includes("UPDATE report_config_sets SET items_json"));
  assert.ok(update,"Sheets winner updates D1");
  assert.equal(update.args[1],s.version);
  assert.ok(!s.batches[0].some(x=>x.sql.includes("INSERT INTO sync_outbox")));
}
{
  const s=await scenario({same:true,d1Time:newer});
  assert.deepEqual(s.res,{resolved:1,unresolved:0,projected:0});
}
{
  const s=await scenario({d1Time:old,sheetTime:old});
  assert.deepEqual(s.res,{resolved:0,unresolved:1,projected:0});
  assert.equal(s.batches.length,0,"equal timestamps preserve conflict");
}
{
  const s=await scenario({legacy:true});
  assert.deepEqual(s.res,{resolved:0,unresolved:1,projected:0});
}
console.log("report-config-lww: ok (D1 newer, Sheets newer, equal, ambiguous, legacy)");
