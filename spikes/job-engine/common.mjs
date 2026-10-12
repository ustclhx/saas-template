import {drizzle} from 'drizzle-orm/postgres-js'
import {sql as statement} from 'drizzle-orm'
import {randomBytes} from 'node:crypto'
import postgres from 'postgres'
export const sql = postgres({host:process.env.PGHOST,database:process.env.PGDATABASE,username:process.env.PGUSER,max:process.argv[2]==='migrate'?1:3,onnotice:()=>{}})
export const businessSql=postgres({host:process.env.PGHOST,database:process.env.PGDATABASE,username:process.env.PGUSER,max:3,onnotice:()=>{}})
export const businessDb=drizzle(businessSql)
let runtimeAdapter
export function bindAdapter(adapter){runtimeAdapter=adapter}
export function uuidv7(){const b=randomBytes(16);b.writeUIntBE(Date.now(),0,6);b[6]=(b[6]&15)|112;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
const serializeEvent=e=>({...e,timestamp:e.timestamp instanceof Date?e.timestamp.toISOString():e.timestamp})
export const sleep = ms => new Promise(r=>setTimeout(r,ms))
export async function migrateCommon() {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS spike;
CREATE TABLE IF NOT EXISTS spike.calls(id bigserial primary key,workflow_id text,step text,worker text,at timestamptz default now());
CREATE TABLE IF NOT EXISTS spike.effects(id text primary key,n int default 1);
CREATE TABLE IF NOT EXISTS spike.batch(id bigserial primary key,worker text,size int,at timestamptz default now());
CREATE TABLE IF NOT EXISTS spike.message_attempt(id bigserial primary key,message_id text,queue text,attempt int,worker text,started_at timestamptz default now(),ended_at timestamptz);
CREATE TABLE IF NOT EXISTS spike.dead_letter(message_id text primary key,queue text,attempts int,reason text,at timestamptz default now());
CREATE TABLE IF NOT EXISTS spike.pipeline_owner(id text primary key,active boolean not null);
CREATE TABLE IF NOT EXISTS spike.business(id text primary key,quota int);
CREATE TABLE IF NOT EXISTS spike.outbox(id text primary key,queue text,body jsonb,published boolean default false);
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA spike TO app,readonly;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA spike TO app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA spike TO app;
GRANT SELECT ON ALL TABLES IN SCHEMA spike TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA spike GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA spike GRANT USAGE,SELECT ON SEQUENCES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA spike GRANT SELECT ON TABLES TO readonly;`)
}
export function handlers(workerId) {
  const call=async(id,step)=> {await sql`insert into spike.calls(workflow_id,step,worker) values(${id},${step},${workerId})`;return Number((await sql`select count(*) n from spike.calls where workflow_id=${id} and step=${step}`)[0].n)}
  const effect=async(id)=> (await sql`insert into spike.effects(id) values(${id}) on conflict do nothing returning id`).length
  return {
    batch:async messages=>{
      await sql`insert into spike.batch(worker,size) values(${workerId},${messages.length})`
      await Promise.all(messages.map(async m=>{
        const [a]=await sql`insert into spike.message_attempt(message_id,queue,attempt,worker) values(${m.id},${m.queue},${m.attempts},${workerId}) returning id`
        if(m.body.crashOnce && await effect(m.id)) process.exit(86)
        await sleep(m.body.durationMs??40)
        if(m.body.fail || (m.body.failOnce && m.attempts===1)) m.retry({delaySeconds:Math.min(900,30*2**(m.attempts-1))})
        else {await effect(m.id);m.ack()}
        await sql`update spike.message_attempt set ended_at=now() where id=${a.id}`
      }))
    },
    workflow:async(p,step,id)=>{
      const once=async name=>step.do(name,async()=>{await call(id,name);await effect(`${id}:${name}`);return {ok:true}})
      if(p.scenario==='basic') {
        await once('first')
        await step.do('retry',{retries:{limit:2,delayMs:200,backoff:'exponential'},timeoutMs:2000},async()=>{if(await call(id,'retry')<3)throw new Error('transient');return 'retried'})
        try {await step.do('no-retry',{retries:{limit:5,delayMs:200,backoff:'constant'}},async()=>{await call(id,'no-retry');const e=new Error('uncertain');e.name='NonRetryableError';throw e})} catch(e) {if(e.name!=='NonRetryableError')throw e}
        await step.sleep('brief',500)
        let timeout=false
        try {await step.waitForEvent('timeout',{type:'absent',timeoutMs:800})}catch(e){if(e.name!=='WaitTimeoutError')throw e;timeout=true}
        try {await step.do('step-timeout',{timeoutMs:200,retries:{limit:0,delayMs:10,backoff:'constant'}},async()=>{await call(id,'step-timeout');await sleep(1500);return 'late'})}catch(e){await call(id,'caught-step-timeout')}
        return {timeout}
      }
      if(p.scenario==='fifo') {
        await step.sleep('early',p.durationMs??3000)
        const out=[]
        for(const [name,type] of [['b','b'],['a1','a'],['a2','a']])out.push(serializeEvent(await step.waitForEvent(name,{type,timeoutMs:2000})))
        try {await step.waitForEvent('a3',{type:'a',timeoutMs:800})}catch(e){if(e.name!=='WaitTimeoutError')throw e;out.push('timeout')}
        return out
      }
      if(p.scenario==='deadline') {
        await once('before-wait')
        const began=await step.do('began',()=>Date.now())
        try{await step.waitForEvent('deadline',{type:'never',timeoutMs:p.durationMs??12000})}catch(e){if(e.name!=='WaitTimeoutError')throw e}
        return {began,ended:Date.now()}
      }
      if(p.scenario==='crash') {
        await once('before')
        await step.do('effect-window',async()=>{await call(id,'effect-window');if(await effect(`${id}:window`))process.exit(87);return 'one-effect'})
        await once('after');return 'recovered'
      }
      if(p.scenario==='long') {
        await once('list')
        await step.do('reserve',async()=>{await call(id,'reserve');await sql.begin(async tx=>{await tx`insert into spike.business(id,quota) values(${id},10) on conflict do nothing`;await tx`insert into spike.effects(id) values(${id+':reserve'}) on conflict do nothing`});return 10})
        await once('details-first')
        await step.sleep('collect-first',Math.floor(p.durationMs/2))
        await once('details-second')
        await step.sleep('collect-second',Math.ceil(p.durationMs/2))
        const event=await step.waitForEvent('early-event',{type:'media-done',timeoutMs:3000})
        await once('merge');await once('summary');return {event:serializeEvent(event),result:'complete'}
      }
      if(p.scenario==='formal-contract') {
        await step.do('linear',{retries:{limit:3,delayMs:100,backoff:'linear'}},async()=>{if(await call(id,'linear')<4)throw new Error('linear-retry');return {ready:true}})
        const event=await step.waitForEvent('formal-event',{type:'media-done',timeoutMs:10000})
        if(!(event.timestamp instanceof Date))throw new Error('event-timestamp-not-Date')
        return {id,isDate:true,payload:event.payload}
      }
      if(p.scenario==='pipeline-v2') {
        const list=await step.do('list',async()=>{await call(id,'list');return Array.from({length:10},(_,n)=>({id:uuidv7(),sku:`sku-${n}`,cluster:n%3}))})
        await step.do('reserve-and-enqueue',async()=>{
          await call(id,'reserve-and-enqueue')
          await businessDb.transaction(async tx=>{
            await tx.execute(statement`insert into spike.business(id,quota) values(${id},10) on conflict do nothing`)
            for(const item of list) await runtimeAdapter.send({id:item.id,queue:'limited',body:{durationMs:180,taskId:id,sku:item.sku}},tx)
          })
          return {items:list.length,quota:10}
        })
        const details=await step.do('details',async()=>{
          await call(id,'details')
          for(;;){const rows=await sql`select id,n from spike.effects where id in ${sql(list.map(item=>item.id))}`;if(rows.length===list.length)return list.map(item=>({...item,detail:'simulated'}));await sleep(100)}
        })
        await step.do('effect-window',async()=>{await call(id,'effect-window');if(await effect(`${id}:window`))process.exit(87);return 'recovered-one-effect'})
        await step.sleep('collect-first',Math.floor(p.durationMs/2))
        await once('details-after-first')
        await step.sleep('collect-second',Math.ceil(p.durationMs/2))
        const event=await step.waitForEvent('early-event',{type:'media-done',timeoutMs:3000})
        const clusters=await step.do('merge',async()=>{await call(id,'merge');return [0,1,2].map(cluster=>({cluster,items:details.filter(item=>item.cluster===cluster).length}))})
        await once('summary')
        return {event:serializeEvent(event),clusters,items:list,quota:10,result:'complete'}
      }
      if(p.scenario==='schedule') {
        await once('schedule-first')
        await step.sleep('schedule-work',p.durationMs??2000)
        if(p.fail)throw new Error('cache-delete-failed')
        if(p.heartbeat) await step.do('heartbeat',async()=>{const [r]=await sql`insert into spike.setting(key,value) values('jobs.lastCronAt',to_jsonb(clock_timestamp())) on conflict(key) do update set value=excluded.value returning value`;return r.value})
        await once('schedule-last');return {scheduledAt:p.scheduledAt}
      }
      throw new Error('unknown scenario')
    }
  }
}
