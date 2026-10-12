import {executeInDrizzle} from './drizzle-bridge.mjs'
import {createServer} from 'node:http'
import {sql,businessSql,businessDb,handlers,migrateCommon,bindAdapter} from './common.mjs'
import {migrateScheduler,startScheduler} from './scheduler.mjs'
const candidate=process.env.CANDIDATE
const {makeAdapter}=await import(`./${candidate}.mjs`)
const workerId=process.env.WORKER_ID??'migrator'
const adapter=await makeAdapter({sql,workerId,handlers:handlers(workerId)})
if(process.argv[2]==='migrate') {
 await migrateCommon();await migrateScheduler(sql);await adapter.migrate();await sql.end();await businessSql.end();process.exit(0)
}
bindAdapter(adapter)
await adapter.start()
let scheduler
let transaction, releaseTransaction
async function control(m){
 try {
  let result
  if(m.method==='usage'){result={workerId,pid:process.pid,memory:process.memoryUsage(),cpu:process.cpuUsage()}}
 else if(m.method==='txStage'||m.method==='txStageDrizzle'){
 const [message]=m.args
 let staged
 const ready=new Promise(r=>staged=r)
 const gate=new Promise(r=>releaseTransaction=r)
 const begin=m.method==='txStageDrizzle'?businessDb.transaction.bind(businessDb):sql.begin
 transaction=begin(async tx=>{if(m.method==='txStageDrizzle')await executeInDrizzle(tx,'insert into spike.business(id,quota) values($1,10)',[message.id]);else await tx`insert into spike.business(id,quota) values(${message.id},10)`;await adapter.send(message,tx);staged();const action=await gate;if(action==='rollback')throw new Error('expected-rollback')})
 transaction.catch(()=>{})
 await ready;result=true
 }else if(m.method==='txFinish'){releaseTransaction(m.args[0]);try{await transaction;result='committed'}catch(e){if(e.message!=='expected-rollback')throw e;result='rolled-back'}}
 else if(m.method==='schedulerStart') {scheduler=await startScheduler({sql,adapter,workerId,definitions:m.args[0]});result=true}
  else if(m.method==='schedulerStop'){await scheduler?.stop?.();if(typeof scheduler==='function')await scheduler();scheduler=undefined;result=true}
  else result=await adapter[m.method](...m.args)
  return {rpc:m.rpc,result}
 }catch(e){return {rpc:m.rpc,error:{name:e.name,message:String(e.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]')}}}
}
process.on('message',async m=>process.send(await control(m)))
const server=createServer(async(req,res)=>{
 if(req.url==='/api/health'){const last=(await sql`select value from spike.setting where key='jobs.lastCronAt'`)[0]?.value??null;const stale=!last||Date.now()-Date.parse(last)>600000;res.writeHead(stale?503:200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({jobs:{lastCronAt:last?new Date(last).toISOString():null},status:stale?'down':'up'}));return}
 let body='';for await(const chunk of req)body+=chunk;const result=await control(JSON.parse(body));res.writeHead(result.error?500:200,{'content-type':'application/json'});res.end(JSON.stringify(result))
}).listen((candidate==='dbos'?14000:15000)+Number(workerId.split('-').at(-1)),'127.0.0.1').unref()
process.send({ready:true,workerId,node:process.version})
setInterval(()=>process.connected && process.send?.({memory:process.memoryUsage(),cpu:process.cpuUsage(),workerId}),15000).unref()
process.on('SIGTERM',async()=>{if((await sql`select id from spike.pipeline_owner where active limit 1`).length){console.log('spike parent finished; retained by pipeline owner');return}if(scheduler?.stop)await scheduler.stop();if(typeof scheduler==='function')await scheduler();await adapter.stop();await sql.end();await businessSql.end();process.exit(0)})
