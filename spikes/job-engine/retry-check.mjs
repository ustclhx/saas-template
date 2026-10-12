import {writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {sql,sleep,uuidv7} from './common.mjs'
const candidate=process.env.CANDIDATE,port=candidate==='dbos'?14000:15000
const report={candidate,start:new Date().toISOString(),messageId:uuidv7(),expectedDelaysSeconds:[30,60,120,240,480],capSeconds:900}
const r=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method:'send',args:[{id:report.messageId,queue:'main',body:{fail:true}}]})});const accepted=await r.json();if(accepted.error)throw new Error(accepted.error.message)
let stop=false
const timer=setInterval(async()=>{const attempts=await sql`select * from spike.message_attempt where message_id=${report.messageId} order by attempt`;report.attempts=attempts;writeFileSync(`reports/${candidate}-retry-recheck.json`,JSON.stringify(report,null,2)+'\n')},15000)
try{
 const began=Date.now()
 for(;;){const [dlq]=await sql`select * from spike.dead_letter where message_id=${report.messageId}`;if(dlq){report.dlq=dlq;break}if(Date.now()-began>1200000)throw new Error('retry timeout');await sleep(500)}
 report.attempts=await sql`select * from spike.message_attempt where message_id=${report.messageId} order by attempt`
 assert.equal(report.attempts.length,6);assert.equal(report.dlq.attempts,6)
 report.actualDelaysSeconds=report.attempts.slice(1).map((a,n)=>(+a.started_at-+report.attempts[n].ended_at)/1000)
 report.actualDelaysSeconds.forEach((d,n)=>assert(d>=report.expectedDelaysSeconds[n]-0.5))
 report.passed=true
}catch(e){report.passed=false;report.error={name:e.name,message:e.message}}
clearInterval(timer);report.end=new Date().toISOString();writeFileSync(`reports/${candidate}-retry-recheck.json`,JSON.stringify(report,null,2)+'\n');await sql.end();process.exit(report.passed?0:1)
