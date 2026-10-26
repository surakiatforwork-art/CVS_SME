import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import worker from "../src/index.js";

const sample={
  complete:true,
  generatedAt:"2026-10-26T01:00:00.000Z",
  teams:[{teamId:"DB_GBKK4",name:"DB_GBKK4",stores:[{id:"1",name:"Example"}]}],
  reportConfigSets:[],
};
const snapshotHash=createHash("sha256")
 .update(JSON.stringify({teams:sample.teams,reportConfigSets:sample.reportConfigSets}))
 .digest("base64url").slice(0,32);

function dbMock(){
 const sqls=[];
 return {sqls,DB:{
   prepare(sql){
     const st={
       sql,args:[], bind(...args){this.args=args;return this;},
       async first(){
         sqls.push(sql);
         if(sql.includes("SELECT payload_json FROM sheet_inbound_events"))
           return {payload_json:JSON.stringify({generatedAt:"2026-10-25T01:00:00.000Z",snapshotHash})};
         return null;
       },
       async all(){sqls.push(sql);return {results:[]}},
       async run(){sqls.push(sql);return {meta:{changes:1}}},
     };
     return st;
   },
   async batch(){throw Error("No-op cycle must not run snapshot batch")},
 }};
}
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async (_url,_opts)=>new Response(JSON.stringify(sample),{
 status:200,headers:{"content-type":"application/json"}
});
const baseEnv={
 SHEET_SYNC_SECRET:"test-sheet-secret",BRIDGE_URL:"https://bridge.test",BRIDGE_SECRET:"test-bridge-secret",
 SESSION_SECRET:"test-session-secret",ADMIN_ACCESS_CODE:"test-admin-code",
 ENABLE_ADMIN_MUTATIONS:"1",ALLOWED_TEAMS:"DB_GBKK4",ALLOWED_REPORT_ACCOUNTS:"LAWSON",
};
try{
 const d=dbMock(),env={...baseEnv,DB:d.DB};
 let waiting;
 await worker.scheduled({scheduledTime:Date.parse("2026-10-26T02:00:00.000Z")},env,{waitUntil(p){waiting=p}});
 const scheduled=await waiting;
 assert.equal(scheduled.ok,true,JSON.stringify(scheduled));
 assert.equal(scheduled.inbound.unchanged,true);
 assert.equal(scheduled.outbound.processed,0);
 assert.ok(d.sqls.some(sql=>sql.includes("INSERT INTO sync_runs")),"history must be persisted");
 assert.ok(d.sqls.some(sql=>sql.includes("UPDATE sync_runs SET status='done'")),"history must finish");

 const login=await worker.fetch(new Request("https://api.test/auth/login",{
   method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:"test-admin-code"})
 }),env,{waitUntil(){}});
 assert.equal(login.status,200,await login.clone().text());
 const token=(await login.json()).token;
 const admin=await worker.fetch(new Request("https://api.test/internal/sync",{
   method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},
   body:JSON.stringify({force:false}),
 }),env,{waitUntil(){}});
 assert.equal(admin.status,200,await admin.clone().text());
 const response=await admin.json();
 assert.equal(response.ok,true);
 assert.equal(response.trigger,"manual");
 console.log("sync-cycle-integration: ok (scheduled + admin manual + history + no-op)");
}finally{globalThis.fetch=fetchOriginal}
