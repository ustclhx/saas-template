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
   try{process.kill(last.pid,0)}catch(e){if(e.code==='ESRCH')exited=true;else throw e}
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
