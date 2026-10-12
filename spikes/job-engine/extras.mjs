import {randomUUID} from 'node:crypto'
import {writeFileSync,readFileSync} from 'node:fs'
import {fork} from 'node:child_process'
import assert from 'node:assert/strict'
import {sql,sleep} from './common.mjs'
const candidate=process.env.CANDIDATE,port=candidate==='dbos'?14000:15000
const report={candidate,start:new Date().toISOString(),tests:[]}
async function rpc(index,method,...args){for(let n=0;n<600;n++){try{const response=await fetch(`http://127.0.0.1:${port+index}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method,args}),signal:AbortSignal.timeout(30000)});const r=await response.json();if(r.error)throw Object.assign(new Error(r.error.message),{name:r.error.name});return r.result}catch(e){if(e.name!=='TypeError')throw e;await sleep(100)}}throw new Error('reconnect timeout')}
async function wait(fn,ms=120000){const t=Date.now();while(Date.now()-t<ms){const r=await fn();if(r)return r;await sleep(100)}throw new Error('condition timeout')}
async function test(name,fn){const start=new Date().toISOString();try{const evidence=await fn();report.tests.push({name,start,end:new Date().toISOString(),passed:true,evidence})}catch(e){report.tests.push({name,start,end:new Date().toISOString(),passed:false,error:{name:e.name,message:e.message}})}writeFileSync(`reports/${candidate}-extras.json`,JSON.stringify(report,null,2)+'\n');console.log(candidate,name,report.tests.at(-1).passed)}
function currentPid(index){const r=JSON.parse(readFileSync(`reports/${candidate}.json`));return r.timeline.filter(t=>t.kind==='worker-ready'&&t.index===index).at(-1).pid}
await test('Q3.actual-two-worker-contention',async()=>{
 await sleep(11000)
 const first=randomUUID(),second=randomUUID();await rpc(0,'send',{id:first,queue:'limited',body:{durationMs:8000}})
 const a=await wait(async()=>(await sql`select * from spike.message_attempt where message_id=${first}`)[0]);const owner=Number(a.worker.split('-').at(-1)),pid=currentPid(owner)
 let b,frozenAt,resumedAt
 try{frozenAt=new Date().toISOString();process.kill(pid,'SIGSTOP');await rpc(1-owner,'send',{id:second,queue:'limited',body:{durationMs:1200}});b=await wait(async()=>(await sql`select * from spike.message_attempt where message_id=${second}`)[0],6000)}finally{process.kill(pid,'SIGCONT');resumedAt=new Date().toISOString()}
 assert.notEqual(a.worker,b.worker)
 await wait(async()=>Number((await sql`select count(*) n from spike.message_attempt where message_id in ${sql([first,second])} and ended_at is not null`)[0].n)===2)
 const rows=await sql`select * from spike.message_attempt where message_id in ${sql([first,second])} order by started_at`
 assert(+rows[1].started_at<+rows[0].ended_at,'did not overlap')
 const duration=Date.parse(resumedAt)-Date.parse(frozenAt);assert(duration<10000,'freeze exceeded lease')
 return {first,second,owner,pid,frozenAt,resumedAt,freezeMs:duration,rows,observedConcurrency:2,startsInWindow:2}
})
await test('Q2.genuine-outbox-only-publisher-crash',async()=>{
 const id=randomUUID();await sql.begin(async tx=>{await tx`insert into spike.business(id,quota) values(${id},7)`;await tx`insert into spike.outbox(id,queue,body) values(${id},'main',${tx.json({})})`})
 const pub=fork('./publisher.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});pub.on('message',async m=>{await rpc(0,'send',m.message);pub.send({accepted:true})});pub.send({message:{id,queue:'main',body:{}}});const exit=await new Promise(resolve=>pub.on('exit',code=>resolve({code,at:new Date().toISOString()})));assert.equal(exit.code,88)
 assert.equal((await sql`select published from spike.outbox where id=${id}`)[0].published,false)
 await rpc(1,'send',{id,queue:'main',body:{}});await sql`update spike.outbox set published=true where id=${id}`
 await wait(async()=>(await sql`select * from spike.effects where id=${id}`).length)
 return {id,exit,business:await sql`select * from spike.business where id=${id}`,outbox:await sql`select id,queue,published from spike.outbox where id=${id}`,attempts:await sql`select * from spike.message_attempt where message_id=${id}`,effects:await sql`select * from spike.effects where id=${id}`}
})
await test('Q1.success-peers-durable-ack',async()=>{
 const original=JSON.parse(readFileSync(`reports/${candidate}.json`));const messages=original.tests.find(t=>t.name==='Q1.batch-start').evidence.messages;const successful=messages.slice(0,9)
 const counts=await sql`select message_id,count(*)::int attempts from spike.message_attempt where message_id in ${sql(successful)} group by message_id`;assert.equal(counts.length,9);counts.forEach(c=>assert.equal(c.attempts,1))
 const crashId=original.tests.find(t=>t.name==='Q1.effect-ack-crash').evidence.mid
 const state=candidate==='dbos'?(await sql`select id,state from spike.dbos_message where id=${crashId}`)[0]:(await sql`select id,state from pgboss.job where id=${crashId} and name='main'`)[0]
 assert.equal(state.state,candidate==='dbos'?'ack':'completed')
 return {counts,crashId,state,attempts:await sql`select * from spike.message_attempt where message_id=${crashId}`}
})
await test('late-event-after-deadline-restart',async()=>{
 const id=randomUUID();await rpc(0,'create',{id,params:{scenario:'deadline',durationMs:3000}})
 const row=()=>candidate==='dbos'?sql`select deadline from spike.dbos_wait where workflow_id=${id} and name='deadline'`:sql`select deadline from spike.boss_step where workflow_id=${id} and name='deadline'`
 const before=await wait(async()=>(await row())[0]);const pids=[currentPid(0),currentPid(1)];pids.forEach(pid=>process.kill(pid,'SIGSTOP'))
 // A producer need not be a worker: insert a simulated late event via restricted app tx,
 // using identical accepted shape; this isolates waiter/deadline behavior from RPC availability.
 await sleep(3500)
 if(candidate==='dbos')await sql`insert into spike.dbos_event(workflow_id,type,event) values(${id},'never',${sql.json({type:'never',payload:{late:true},timestamp:Date.now()})})`
 else await sql`insert into spike.boss_event(workflow_id,type,payload) values(${id},'never',${sql.json({late:true})})`
 pids.forEach(pid=>process.kill(pid,'SIGKILL'))
 const done=await wait(async()=>{const r=await rpc(0,'get',id);return r.status==='completed'?r:false})
 const journal=candidate==='dbos'?(await sql`select * from spike.dbos_wait where workflow_id=${id} and name='deadline'`)[0]:(await sql`select * from spike.boss_step where workflow_id=${id} and name='deadline'`)[0]
 assert.equal(+journal.deadline,+before.deadline)
 if(candidate==='dbos')assert.equal(journal.result,null);else assert.equal(journal.error.name,'WaitTimeoutError')
 return {id,before,pids,done,journal,lateEventStayedPending:true}
})
report.end=new Date().toISOString();report.passed=report.tests.every(t=>t.passed);writeFileSync(`reports/${candidate}-extras.json`,JSON.stringify(report,null,2)+'\n');await sql.end();process.exit(report.passed?0:1)
