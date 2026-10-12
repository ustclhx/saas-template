import postgres from 'postgres'
import {writeFileSync} from 'node:fs'
const result={at:new Date().toISOString(),databases:[]}
for(const database of ['dbos_spike','boss_spike']) {
 const d={database,checks:[]}
 for(const username of ['app','readonly']) {
  const sql=postgres({host:process.env.PGHOST,database,username,max:1,onnotice:()=>{}})
  d.checks.push({username,privileges:await sql`select nspname,has_schema_privilege(current_user,n.oid,'USAGE') as usage,has_schema_privilege(current_user,n.oid,'CREATE') as can_create from pg_namespace n where nspname in ('spike','dbos','pgboss')`})
  try{await sql`create table spike.denied_create(id int)`;d.checks.push({username,deniedCreate:false})}catch(e){d.checks.push({username,deniedCreate:e.code==='42501'})}
  try{await sql`create temporary table denied_temp(id int)`;d.checks.push({username,deniedTempCreate:false})}catch(e){d.checks.push({username,deniedTempCreate:e.code==='42501'})}
  try{await sql`alter table spike.effects add column denied_column int`;d.checks.push({username,deniedAlter:false})}catch(e){d.checks.push({username,deniedAlter:e.code==='42501'})}
  if(username==='readonly'){const rows=await sql`select count(*) n from spike.calls`;d.checks.push({readonlyQuery:rows});try{await sql`insert into spike.effects(id) values('readonly-denied')`;d.checks.push({deniedWrite:false})}catch(e){d.checks.push({deniedWrite:e.code==='42501'})}}
  await sql.end()
 }
 result.databases.push(d)
}
writeFileSync('reports/permissions.json',JSON.stringify(result,null,2)+'\n')
