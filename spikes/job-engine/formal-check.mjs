import {writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {sql,sleep,uuidv7} from './common.mjs'
const candidate=process.env.CANDIDATE,port=candidate==='dbos'?14000:15000
const result={candidate,start:new Date().toISOString(),interfaceSha:'8c21cd20a48e0db3a696681a14b57766397d78d5'}
async function rpc(method,...args){for(let n=0;n<600;n++){try{const r=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method,args})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result}catch(e){if(e.name!=='TypeError')throw e;await sleep(100)}}throw new Error('reconnect timeout')}
try {
 const id='formal-string-'+uuidv7();result.id=id
 await rpc('create',{id,params:{scenario:'formal-contract'}})
 await rpc('sendEvent',id,{type:'media-done',payload:{ready:true}})
 const start=Date.now();let done
 for(;;){const r=await rpc('get',id);assert.notEqual(r.status,'failed',JSON.stringify(r.error));if(r.status==='completed'){done=r;break}if(Date.now()-start>30000)throw new Error('contract timeout');await sleep(100)}
 result.result=done;assert.equal(done.output.isDate,true);assert.deepEqual(done.output.payload,{ready:true})
 result.calls=await sql`select * from spike.calls where workflow_id=${id} and step='linear' order by id`;assert.equal(result.calls.length,4)
 result.delaysMs=result.calls.slice(1).map((row,n)=>+row.at-result.calls[n].at);assert(result.delaysMs[0]>=90&&result.delaysMs[1]>=190&&result.delaysMs[2]>=290);assert(result.delaysMs[2]<390,'linear became exponential')
 // Stable arbitrary string identity must return existing result without redoing callbacks.
 await rpc('create',{id,params:{scenario:'formal-contract'}});assert.equal((await sql`select count(*)::int n from spike.calls where workflow_id=${id} and step='linear'`)[0].n,4)
 result.passed=true
}catch(e){result.passed=false;result.error={name:e.name,message:e.message}}
result.end=new Date().toISOString();writeFileSync(`reports/${candidate}-formal-contract.json`,JSON.stringify(result,null,2)+'\n');await sql.end();process.exit(result.passed?0:1)
