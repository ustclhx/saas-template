import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {sql,sleep,uuidv7} from './common.mjs'
const candidate=process.env.CANDIDATE,port=candidate==='dbos'?14000:15000
const r={candidate,start:new Date().toISOString(),minimumEventRetentionSeconds:3600,experimentCutoffSeconds:86400}
async function rpc(method,...args){const response=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method,args})});const j=await response.json();if(j.error)throw new Error(j.error.message);return j.result}
try {
 const terminal=uuidv7(),active=JSON.parse(readFileSync(`reports/${candidate}-pipeline.json`)).workflowId;r.ids={terminal,active}
 await rpc('create',{id:terminal,params:{scenario:'fifo',durationMs:30}})
 for(const [type,n]of[['a',1],['a',2],['b',3]])await rpc('sendEvent',terminal,{type,payload:{n}})
 for(let n=0;n<300;n++){if((await rpc('get',terminal)).status==='completed')break;await sleep(100)}
 assert.equal((await rpc('get',terminal)).status,'completed')
 if(candidate==='dbos'){
  const old={type:'retention-only',payload:{synthetic:true},timestamp:Date.now()-172800000}
  for(const id of [terminal,active])await sql`insert into spike.dbos_event(workflow_id,type,event) values(${id},'retention-only',${sql.json(old)})`
  r.deleted=await sql`delete from spike.dbos_event e using dbos.workflow_status w where e.workflow_id=w.workflow_uuid and e.workflow_id in ${sql([terminal,active])} and e.type='retention-only' and w.status in ('SUCCESS','ERROR','CANCELLED') and to_timestamp((e.event->>'timestamp')::double precision/1000)<clock_timestamp()-interval '1 day' returning e.workflow_id`
  r.preserved=await sql`select workflow_id from spike.dbos_event where workflow_id=${active} and type='retention-only'`
 }else{
  for(const id of [terminal,active])await sql`insert into spike.boss_event(workflow_id,type,payload,at) values(${id},'retention-only',${sql.json({synthetic:true})},clock_timestamp()-interval '2 days')`
  r.deleted=await sql`delete from spike.boss_event e using spike.boss_workflow w where e.workflow_id=w.id and e.workflow_id in ${sql([terminal,active])} and e.type='retention-only' and w.status in ('completed','failed','terminated') and e.at<clock_timestamp()-interval '1 day' returning e.workflow_id`
  r.preserved=await sql`select workflow_id from spike.boss_event where workflow_id=${active} and type='retention-only'`
 }
 assert.equal(r.deleted.length,1);assert.equal(r.deleted[0].workflow_id,terminal);assert.equal(r.preserved.length,1)
 r.passed=true;r.scope='Manual owned-inbox SQL retention feasibility; not production automatic cleanup. Active aged fixture retained; real early event untouched.'
}catch(e){r.passed=false;r.error={name:e.name,message:e.message}}
r.end=new Date().toISOString();writeFileSync(`reports/${candidate}-retention.json`,JSON.stringify(r,null,2)+'\n');await sql.end();process.exit(r.passed?0:1)
