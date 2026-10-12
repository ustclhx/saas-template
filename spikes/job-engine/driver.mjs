import {fork} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {writeFileSync,appendFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {sql,sleep} from './common.mjs'
import {registerSchedules,nextSlot} from './scheduler.mjs'
const candidate=process.env.CANDIDATE
const report={candidate,start:new Date().toISOString(),tests:[],timeline:[],resources:[],node:process.version}
const out=`reports/${candidate}.json`
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n')
const stamp=(kind,data={})=>{report.timeline.push({at:new Date().toISOString(),kind,...data});save()}
function id(){const b=randomBytes(16);b.writeUIntBE(Date.now(),0,6);b[6]=(b[6]&15)|112;b[8]=(b[8]&63)|128;const s=b.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`}
let seq=0,closing=false
const workers=[]
async function launch(index){
 const w={index,ready:false,pending:new Map()}
 workers[index]=w
 const c=fork('./worker.mjs',[],{env:{...process.env,WORKER_ID:`${candidate}-${index}`},stdio:['ignore','pipe','pipe','ipc']})
 w.child=c
 for(const stream of [c.stdout,c.stderr])stream.on('data',b=>appendFileSync(`reports/${candidate}-engine.log`,String(b).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[redacted]').replace(/password[^\n]+/ig,'password [redacted]')))
 c.on('message',m=>{if(m.ready){w.ready=true;stamp('worker-ready',{index,pid:c.pid,node:m.node})}else if(m.rpc){const p=w.pending.get(m.rpc);if(p){w.pending.delete(m.rpc);m.error?p.reject(Object.assign(new Error(m.error.message),{name:m.error.name})):p.resolve(m.result)}}else if(m.memory){report.resources.push({at:new Date().toISOString(),...m});save()}})
 c.on('exit',(code,signal)=>{w.ready=false;stamp('worker-exit',{index,code,signal});for(const p of w.pending.values())p.reject(new Error('worker-exit'));w.pending.clear();if(!closing)setTimeout(()=>launch(index).catch(e=>stamp('restart-error',{name:e.name})),500)})
 for(let n=0;n<300&&!w.ready;n++)await sleep(100)
 if(!w.ready)throw new Error('worker-start-timeout')
 return w
}
async function rpc(method,...args){
 let w
 for(let n=0;n<600;n++){w=workers.find(w=>w?.ready);if(w)break;await sleep(100)}
 if(!w)throw new Error('no-worker')
 const rid=++seq
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{w.pending.delete(rid);reject(new Error(`rpc-timeout:${method}`))},30000);w.pending.set(rid,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});w.child.send({rpc:rid,method,args})})
}
async function eachRpc(method,...args){for(const w of workers){const n=workers.indexOf(w);if(!w.ready)throw new Error('worker-not-ready');const rid=++seq;await new Promise((resolve,reject)=>{w.pending.set(rid,{resolve,reject});w.child.send({rpc:rid,method,args})});stamp('worker-control',{index:n,method})}}
async function waitFor(fn,ms=180000){const began=Date.now();while(Date.now()-began<ms){const r=await fn();if(r)return r;await sleep(250)}throw new Error('condition-timeout')}
async function complete(wid,ms=180000){return waitFor(async()=>{const r=await rpc('get',wid);if(r.status==='failed')throw new Error(`workflow-failed:${r.error}`);return r.status==='completed'?r:false},ms)}
async function test(name,fn){const start=new Date().toISOString();try{const evidence=await fn();report.tests.push({name,start,end:new Date().toISOString(),passed:true,evidence})}catch(e){report.tests.push({name,start,end:new Date().toISOString(),passed:false,error:{name:e.name,message:e.message}})}save();console.log(`${candidate} ${name}: ${report.tests.at(-1).passed?'PASS':'FAIL'}`)}
await launch(0);await launch(1)
const measure=setInterval(async()=>{try{const [r]=await sql`select count(*) filter(where datname=current_database())::int connections,pg_database_size(current_database())::text database_bytes,pg_current_wal_lsn()::text wal_lsn from pg_stat_activity`;report.resources.push({at:new Date().toISOString(),database:r});save()}catch{}},15000)
// Long real-time scenarios start before short fault tests and share identical definitions.
const longId=id(),durationMs=3665000
await rpc('create',{id:longId,params:{scenario:'long',durationMs}})
await rpc('sendEvent',longId,{type:'media-done',payload:{id:'early',sentAt:new Date().toISOString()}})
stamp('long-start',{id:longId,durationMs})
await test('Q2.transaction',async()=>{
 const rolled=id(),committed=id(),uncommitted=id()
 await rpc('txStage',{id:uncommitted,queue:'main',body:{}})
 await sleep(5500)
 assert.equal((await sql`select * from spike.business where id=${uncommitted}`).length,0)
 assert.equal((await sql`select * from spike.message_attempt where message_id=${uncommitted}`).length,0)
 await rpc('txFinish','commit')
 await rpc('txStage',{id:rolled,queue:'main',body:{}})
 await rpc('txFinish','rollback')
 await rpc('txStage',{id:committed,queue:'main',body:{}})
 await rpc('txFinish','commit')
 await sql`insert into spike.outbox(id,queue,body) values(${committed},'main',${sql.json({})})`
 // Simulate publisher crash at acceptance boundary by exiting this isolated child after RPC acceptance.
 const rows=await sql`select * from spike.outbox where not published`
 const pub=fork('./publisher.mjs',[],{stdio:['ignore','ignore','ignore','ipc']})
 pub.on('message',async r=>{await rpc('send',r.message);pub.send({accepted:true})})
 pub.send({message:{id:committed,queue:'main',body:{}}})
 await new Promise(resolve=>pub.on('exit',(code)=>{assert.equal(code,88);stamp('publisher-process-exit',{code});resolve()}))
 stamp('publisher-accepted-before-mark',{ids:rows.map(r=>r.id)})
 await rpc('sendBatch',rows.map(r=>({id:r.id,queue:r.queue,body:r.body})))
 await sql`update spike.outbox set published=true where not published`
 await waitFor(async()=>Number((await sql`select count(*) n from spike.effects where id in ${sql([uncommitted,committed])}`)[0].n)===2)
 assert.equal((await sql`select * from spike.business where id=${rolled}`).length,0)
 assert.equal((await sql`select * from spike.message_attempt where message_id=${rolled}`).length,0)
 return {rolled,committed,uncommitted,effects:await sql`select * from spike.effects where id in ${sql([uncommitted,committed])}`,publisherBoundary:'accepted then repeated before marking'}
})
let retryId
await test('Q1.batch-start',async()=>{
 const messages=Array.from({length:10},(_,n)=>({id:id(),queue:'main',body:{fail:n===9}}));retryId=messages[9].id
 await rpc('sendBatch',messages)
 await waitFor(async()=>Number((await sql`select count(*) n from spike.effects where id in ${sql(messages.slice(0,9).map(m=>m.id))}`)[0].n)===9)
 const batches=await sql`select * from spike.batch order by id`
 assert(batches.some(b=>b.size===10),'no actual10 batch')
 return {messages:messages.map(m=>m.id),batches}
})
await test('Q3.global-limits',async()=>{
 const messages=Array.from({length:10},(_,n)=>({id:id(),queue:'limited',body:{durationMs:1800,failOnce:n===0}}));const other=id()
 await rpc('sendBatch',messages);await rpc('send',{id:other,queue:'other',body:{}})
 await waitFor(async()=>Number((await sql`select count(*) n from spike.effects where id in ${sql(messages.map(m=>m.id))}`)[0].n)===10,180000)
 const attempts=await sql`select * from spike.message_attempt where queue='limited' order by started_at,id`
 let peak=0,maxWindow=0
 for(const a of attempts){const t=+a.started_at;peak=Math.max(peak,attempts.filter(b=>+b.started_at<=t&&(!b.ended_at||+b.ended_at>t)).length);maxWindow=Math.max(maxWindow,attempts.filter(b=>+b.started_at>=t&&+b.started_at<t+10000).length)}
 assert(peak<=2,`concurrency${peak}`);assert(maxWindow<=3,`rate${maxWindow}`)
 assert(attempts.some(a=>a.attempt===2),'retry not counted')
 assert((await sql`select * from spike.effects where id=${other}`).length===1)
 const workerIds=[...new Set(attempts.map(a=>a.worker))]
 return {peak,maxWindow,attempts,workerIds,otherIndependent:other,batches:await sql`select * from spike.batch where size>1`}
})
await test('W1.basic',async()=>{const wid=id();await rpc('create',{id:wid,params:{scenario:'basic'}});const result=await complete(wid);const counts=await sql`select step,count(*)::int n from spike.calls where workflow_id=${wid} group by step`;assert.equal(counts.find(c=>c.step==='first').n,1);assert.equal(counts.find(c=>c.step==='retry').n,3);assert.equal(counts.find(c=>c.step==='no-retry').n,1);assert.equal(counts.find(c=>c.step==='caught-step-timeout')?.n,1);assert.equal(result.output.timeout,true);return {wid,result,counts}})
await test('W3.FIFO',async()=>{const wid=id();await rpc('create',{id:wid,params:{scenario:'fifo'}});for(const [type,n]of[['a',1],['a',2],['b',3]])await rpc('sendEvent',wid,{type,payload:{n}});const result=await complete(wid);assert.deepEqual(result.output.map(x=>typeof x==='string'?x:x.payload.n),[3,1,2,'timeout']);await assert.rejects(rpc('sendEvent',wid,{type:'a',payload:{}}));await assert.rejects(rpc('sendEvent',id(),{type:'a',payload:{}}));return {wid,result}})
await test('W2.wait-deadline-restart',async()=>{const wid=id();await rpc('create',{id:wid,params:{scenario:'deadline',durationMs:12000}});await waitFor(async()=>(await sql`select * from spike.calls where workflow_id=${wid} and step='before-wait'`).length);await sleep(4000);stamp('forced-restart-wait',{wid});for(const w of workers)w.child.kill('SIGKILL');await sleep(2000);const result=await complete(wid);assert(result.output.ended-result.output.began<15000,'deadline extended');return {wid,result,calls:await sql`select * from spike.calls where workflow_id=${wid}`}})
await test('W2.effect-checkpoint-crash',async()=>{const wid=id();await rpc('create',{id:wid,params:{scenario:'crash'}});const result=await complete(wid,240000);const counts=await sql`select step,count(*)::int n from spike.calls where workflow_id=${wid} group by step`;assert.equal(counts.find(x=>x.step==='before').n,1);assert.equal(counts.find(x=>x.step==='effect-window').n,2);assert.equal((await sql`select * from spike.effects where id=${wid+':window'}`).length,1);return {wid,result,counts}})
await test('Q1.effect-ack-crash',async()=>{const mid=id();await rpc('send',{id:mid,queue:'main',body:{crashOnce:true}});await waitFor(async()=>Number((await sql`select count(*) n from spike.message_attempt where message_id=${mid}`)[0].n)>=2,240000);assert.equal((await sql`select * from spike.effects where id=${mid}`).length,1);return {mid,attempts:await sql`select * from spike.message_attempt where message_id=${mid}`}})
await test('J1.J2.scheduler',async()=>{
 const next=nextSlot('0 2 * * *','Asia/Singapore',new Date('2026-10-12T17:00:00Z'));assert.equal(new Date(next).toISOString(),'2026-10-12T18:00:00.000Z')
 const defs=[{id:'skip',cron:'*/5 * * * * *',timeZone:'Asia/Singapore',missedRun:'skip',params:{scenario:'schedule',durationMs:8000}},{id:'once',cron:'*/5 * * * * *',timeZone:'Asia/Singapore',missedRun:'once',params:{scenario:'schedule',durationMs:8000}}]
 await registerSchedules(sql,defs)
 await eachRpc('schedulerStart');await sleep(23000);await eachRpc('schedulerStop')
 const before=await sql`select * from spike.schedule_run order by scheduled_at`
 await sleep(18000)
 const restartAt=new Date();await eachRpc('schedulerStart');await sleep(16000);await eachRpc('schedulerStop')
 const runs=await sql`select * from spike.schedule_run order by scheduled_at`
 assert(new Set(runs.map(r=>r.id)).size===runs.length)
 for(const sid of ['skip','once']){const rs=runs.filter(r=>r.schedule_id===sid&&r.started_at&&r.finished_at);for(let n=1;n<rs.length;n++)assert(+rs[n].started_at>=+rs[n-1].finished_at,'schedule overlap')}
 const offline=runs.filter(r=>+r.scheduled_at<+restartAt&&!before.some(b=>b.id===r.id))
 assert.equal(offline.filter(r=>r.schedule_id==='skip').length,0)
 assert.equal(offline.filter(r=>r.schedule_id==='once').length,1)
 return {nextSingapore02:new Date(next).toISOString(),before,restartAt:runs.length?restartAt.toISOString():null,runs,offline}
})
await test('J3.heartbeat',async()=>{
 const health=async()=>({headers:{'cache-control':'no-store'},lastCronAt:(await sql`select value from spike.setting where key='jobs.lastCronAt'`)[0]?.value??null})
 const initial=await health();assert.equal(initial.lastCronAt,null)
 await registerSchedules(sql,[{id:'heartbeat',cron:'*/5 * * * *',timeZone:'UTC',missedRun:'skip',params:{scenario:'schedule',durationMs:100,heartbeat:true}}])
 await eachRpc('schedulerStart')
 await waitFor(async()=>(await health()).lastCronAt,310000)
 const success=await health();await eachRpc('schedulerStop')
 const failure=id();await rpc('create',{id:failure,params:{scenario:'schedule',durationMs:100,heartbeat:true,fail:true}})
 await waitFor(async()=>(await rpc('get',failure)).status==='failed')
 assert.equal((await health()).lastCronAt,success.lastCronAt)
 stamp('heartbeat-offline-start',{success})
 await sleep(601000)
 const stale=await health();assert.equal(stale.lastCronAt,success.lastCronAt);assert(Date.now()-Date.parse(stale.lastCronAt)>600000)
 return {initial,success,failure,stale,ledger:await sql`select * from spike.schedule_run where schedule_id='heartbeat'`}
})
await test('Q1.retry-exhaustion',async()=>{
 await waitFor(async()=>(await sql`select * from spike.dead_letter where message_id=${retryId}`)[0],1100000)
 const dlq=(await sql`select * from spike.dead_letter where message_id=${retryId}`)[0]
 const attempts=await sql`select * from spike.message_attempt where message_id=${retryId} order by attempt`
 assert.equal(attempts.length,6);assert.equal(dlq.attempts,6)
 const delays=attempts.slice(1).map((r,n)=>(+r.started_at-+attempts[n].ended_at)/1000)
 delays.forEach((d,n)=>assert(d>=30*2**n-0.5,`backoff${n}=${d}`))
 return {retryId,dlq,attempts,delays,capSeconds:900}
})
await test('W2.W3.long',async()=>{
 const result=await complete(longId,4000000)
 const calls=await sql`select step,count(*)::int n,min(at) started,max(at) ended from spike.calls where workflow_id=${longId} group by step`
 for(const c of calls)assert.equal(c.n,1,`successful step repeated${c.step}`)
 const elapsed=Date.now()-Date.parse(report.timeline.find(t=>t.kind==='long-start').at)
 assert(elapsed>=3600000);assert.equal(result.output.result,'complete');const age=Date.now()-Date.parse(result.output.event.payload.sentAt);assert(age>3600000)
 return {longId,durationMs,elapsedMs:elapsed,earlyEventAgeMs:age,result,calls}
})
clearInterval(measure);closing=true
for(const w of workers)w.child.kill('SIGTERM')
await sql.end();report.end=new Date().toISOString();report.passed=report.tests.every(t=>t.passed);save();console.log(`${candidate} driver complete:${report.passed}`)
setTimeout(()=>process.exit(report.passed?0:1),5000)
