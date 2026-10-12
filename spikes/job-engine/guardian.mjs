// 仅实验控制器：初轮 driver 结束后，把已确认退出的 worker 交给长跑 controller。
import {fork} from 'node:child_process'
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const children=new Map()
for(;;){
 let finished=0
 for(const candidate of ['dbos','boss']) {
  const path=`reports/${candidate}.json`,r=JSON.parse(readFileSync(path))
  const pipeline=JSON.parse(readFileSync(`reports/${candidate}-pipeline.json`))
  if(pipeline.end){finished++;continue}
  if(!r.end)continue
  for(const index of [0,1]){
   const key=`${candidate}-${index}`
   const last=r.timeline.filter(t=>t.kind==='worker-ready'&&t.index===index).at(-1)
   let exited=false
   try{const argv=readFileSync(`/proc/${last.pid}/cmdline`,'utf8').split('\0');const env=readFileSync(`/proc/${last.pid}/environ`,'utf8').split('\0');exited=argv[0]!=='/spike/runtime/bin/node'||!argv[1]?.endsWith('worker.mjs')||!env.includes(`WORKER_ID=${key}`)}catch(e){if(e.code==='ENOENT')exited=true;else throw e}
   if(exited){try{const response=await fetch(`http://127.0.0.1:${(candidate==='dbos'?14000:15000)+index}/rpc`,{method:'POST',body:JSON.stringify({rpc:1,method:'usage',args:[]}),signal:AbortSignal.timeout(1000)});const current=await response.json();if(current.result?.workerId===key)continue}catch{}}
   if(!exited||children.has(key))continue
   const child=fork('./worker.mjs',[],{env:{...process.env,PGHOST:'localhost',PGDATABASE:`${candidate==='dbos'?'dbos':'boss'}_spike`,PGUSER:'app',CANDIDATE:candidate,WORKER_ID:key},stdio:['ignore','pipe','pipe','ipc']})
   children.set(key,child)
   for(const stream of [child.stdout,child.stderr])stream.on('data',b=>appendFileSync(`reports/${candidate}-engine.log`,String(b).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[redacted]')))
   child.on('message',m=>{if(m.ready){const current=JSON.parse(readFileSync(path));const event={at:new Date().toISOString(),kind:'worker-ready',index,pid:child.pid,node:m.node,owner:'pipeline-guardian'};current.timeline.push(event);writeFileSync(path,JSON.stringify(current,null,2)+'\n');appendFileSync('reports/guardian.jsonl',JSON.stringify(event)+'\n')}})
   child.on('exit',(code,signal)=>{children.delete(key);appendFileSync('reports/guardian.jsonl',JSON.stringify({at:new Date().toISOString(),kind:'worker-exit',key,pid:child.pid,code,signal})+'\n')})
  }
 }
 if(finished===2)break
 await pause(500)
}
