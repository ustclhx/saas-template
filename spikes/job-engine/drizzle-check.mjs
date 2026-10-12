import {writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {sql,sleep,uuidv7} from './common.mjs'
const candidate=process.env.CANDIDATE,port=candidate==='dbos'?14000:15000
const report={candidate,start:new Date().toISOString(),kind:'real-drizzle-postgres-js-transaction'}
async function rpc(method,...args){for(let n=0;n<600;n++){try{const response=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method,args})});const r=await response.json();if(r.error)throw new Error(r.error.message);return r.result}catch(e){if(e.name!=='TypeError')throw e;await sleep(100)}}throw new Error('reconnect timeout')}
try {
 const commit=uuidv7(),rollback=uuidv7();report.ids={commit,rollback}
 await rpc('txStageDrizzle',{id:commit,queue:'main',body:{taskId:'drizzle-commit'}});await sleep(6000)
 report.uncommitted={business:await sql`select * from spike.business where id=${commit}`,executions:await sql`select * from spike.message_attempt where message_id=${commit}`};assert.equal(report.uncommitted.business.length,0);assert.equal(report.uncommitted.executions.length,0)
 assert.equal(await rpc('txFinish','commit'),'committed')
 await rpc('txStageDrizzle',{id:rollback,queue:'main',body:{taskId:'drizzle-rollback'}});assert.equal(await rpc('txFinish','rollback'),'rolled-back')
 for(let n=0;n<300;n++){if((await sql`select * from spike.effects where id=${commit}`).length)break;await sleep(100)}
 report.committed={business:await sql`select * from spike.business where id=${commit}`,effects:await sql`select * from spike.effects where id=${commit}`,executions:await sql`select * from spike.message_attempt where message_id=${commit}`};report.rolledBack={business:await sql`select * from spike.business where id=${rollback}`,executions:await sql`select * from spike.message_attempt where message_id=${rollback}`};assert.equal(report.committed.effects.length,1);assert.equal(report.rolledBack.business.length,0);assert.equal(report.rolledBack.executions.length,0)
 report.passed=true
}catch(e){report.passed=false;report.error={name:e.name,message:e.message}}
report.end=new Date().toISOString();writeFileSync(`reports/${candidate}-drizzle-transaction.json`,JSON.stringify(report,null,2)+'\n');await sql.end();process.exit(report.passed?0:1)
