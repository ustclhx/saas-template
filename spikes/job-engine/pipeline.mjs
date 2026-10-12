import {writeFileSync,readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {sql,sleep,uuidv7} from './common.mjs'
const candidate=process.env.CANDIDATE,port=candidate==='dbos'?14000:15000
const report={candidate,start:new Date().toISOString(),workflowId:uuidv7(),durationMs:3665000,timeline:[]}
const save=()=>writeFileSync(`reports/${candidate}-pipeline.json`,JSON.stringify(report,null,2)+'\n')
const stamp=(kind,data={})=>{report.timeline.push({at:new Date().toISOString(),kind,...data});save()}
async function rpc(method,...args){for(let n=0;n<600;n++){try{const response=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method,args}),signal:AbortSignal.timeout(30000)});const r=await response.json();if(r.error)throw Object.assign(new Error(r.error.message),{name:r.error.name});return r.result}catch(e){if(!['TypeError','TimeoutError'].includes(e.name))throw e;await sleep(100)}}throw new Error('reconnect timeout')}
async function wait(fn,ms=4200000){const start=Date.now();while(Date.now()-start<ms){const r=await fn();if(r)return r;await sleep(250)}throw new Error('condition timeout')}
function restart(kind){const r=JSON.parse(readFileSync(`reports/${candidate}.json`));const pids=[0,1].map(index=>r.timeline.filter(t=>t.kind==='worker-ready'&&t.index===index).at(-1).pid);stamp(kind,{pids});for(const pid of pids)process.kill(pid,'SIGKILL')}
await sql`insert into spike.pipeline_owner(id,active) values(${report.workflowId},true)`
const usageTimer=setInterval(async()=>{try{const usage=await rpc('usage');report.resources??=[];report.resources.push({at:new Date().toISOString(),...usage});save()}catch{}},15000)
try {
 await rpc('create',{id:report.workflowId,params:{scenario:'pipeline-v2',durationMs:report.durationMs}})
 report.eventSentAt=new Date().toISOString();await rpc('sendEvent',report.workflowId,{type:'media-done',payload:{sentAt:report.eventSentAt,ready:true}});stamp('created-and-early-event-sent')
 await wait(async()=>Number((await sql`select count(*) n from spike.calls where workflow_id=${report.workflowId} and step='effect-window'`)[0].n)===2,180000)
 await sleep(2000);restart('forced-restart-first-sleep')
 await wait(async()=>(await sql`select * from spike.calls where workflow_id=${report.workflowId} and step='details-after-first'`).length,2200000)
 await sleep(2000);restart('forced-restart-second-sleep')
 const result=await wait(async()=>{const r=await rpc('get',report.workflowId);if(r.status==='failed')throw new Error(JSON.stringify(r.error));return r.status==='completed'?r:false})
 report.result=result
 report.calls=await sql`select step,count(*)::int n,min(at) started,max(at) ended from spike.calls where workflow_id=${report.workflowId} group by step order by min(at)`
 for(const call of report.calls)assert.equal(call.n,call.step==='effect-window'?2:1,call.step)
 assert.equal((await sql`select * from spike.effects where id=${report.workflowId+':window'}`).length,1)
 report.messageAttempts=await sql`select * from spike.message_attempt where message_id in ${sql(result.output.items.map(item=>item.id))} order by started_at`
 assert.equal(report.messageAttempts.length,10)
 const concurrency=report.messageAttempts.map(a=>report.messageAttempts.filter(b=>+b.started_at<=+a.started_at&&+b.ended_at>+a.started_at).length)
 report.peakConcurrency=Math.max(...concurrency);assert(report.peakConcurrency<=2)
 report.maxRollingWindow=Math.max(...report.messageAttempts.map(a=>report.messageAttempts.filter(b=>+b.started_at>=+a.started_at&&+b.started_at<+a.started_at+10000).length));assert(report.maxRollingWindow<=3)
 assert.equal(result.output.clusters.reduce((n,c)=>n+c.items,0),10)
 report.elapsedMs=Date.now()-Date.parse(report.start);report.eventAgeMs=Date.now()-Date.parse(report.eventSentAt);assert(report.elapsedMs>=3600000&&report.elapsedMs<=7200000);assert(report.eventAgeMs>3600000)
 report.quota=(await sql`select * from spike.business where id=${report.workflowId}`)[0];assert.equal(report.quota.quota,10)
 report.passed=true;stamp('completed')
} catch(e){report.passed=false;report.error={name:e.name,message:e.message};stamp('failed')}
clearInterval(usageTimer);await sql`update spike.pipeline_owner set active=false where id=${report.workflowId}`;report.end=new Date().toISOString();save();await sql.end();process.exit(report.passed?0:1)
