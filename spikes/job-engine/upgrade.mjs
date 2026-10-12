import postgres from 'postgres'
import {writeFileSync} from 'node:fs'
const sql=postgres({host:process.env.PGHOST,database:process.env.PGDATABASE,username:process.env.PGUSER,max:1,onnotice:()=>{}})
const candidate=process.env.CANDIDATE
const r={candidate,start:new Date().toISOString(),steps:[]}
async function dbosMigration(old){
 const u=new URL('postgresql://localhost');u.hostname=process.env.PGHOST;u.username=process.env.PGUSER;u.pathname='/'+process.env.PGDATABASE
 if(old){const {migrate}=await import('./upgrades/dbos/node_modules/@dbos-inc/dbos-sdk/dist/src/cli/migrate.js');const logger={info(){},warn(){},error(){},debug(){}};const code=await migrate([],u.toString(),logger);if(code!==0)throw new Error('old-cli-migration-failed')}
 else {const {DBOS}=await import('@dbos-inc/dbos-sdk');await DBOS.migrate(u.toString(),{applicationRole:'app'})}
}
async function bossMigration(old){const {PgBoss}=await import(old?'./upgrades/boss/node_modules/pg-boss/dist/index.js':'pg-boss');const b=new PgBoss({db:{executeSql:async(text,values=[])=>({rows:await sql.unsafe(text,values)})},migrate:true,createSchema:true,schedule:false,supervise:false});b.on('error',()=>{});await b.start();await b.stop()}
const run=candidate==='dbos'?dbosMigration:bossMigration
for(const [name,old]of[['previous-init',true],['previous-repeat',true],['upgrade',false],['upgrade-repeat',false]]){try{await run(old);r.steps.push({name,passed:true,at:new Date().toISOString()})}catch(e){r.steps.push({name,passed:false,error:e.name,message:e.message});break}}
r.schema=await sql`select schemaname,tablename from pg_tables where schemaname in ('dbos','pgboss') order by schemaname,tablename`
r.end=new Date().toISOString();writeFileSync(`reports/${candidate}-upgrade.json`,JSON.stringify(r,null,2));await sql.end()
