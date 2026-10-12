import pgUtils from 'pg/lib/utils.js'
import {sql as statement} from 'drizzle-orm'
// 查询模板来自固定版引擎；数据仍由 Drizzle 参数绑定，不插值成 SQL。
export async function executeInDrizzle(tx,text,values=[]) {
 const query=statement.empty()
 let offset=0
 for(const match of text.matchAll(/\$(\d+)/g)) {
  query.append(statement.raw(text.slice(offset,match.index)))
  query.append(statement`${pgUtils.prepareValue(values[Number(match[1])-1])}`)
  offset=match.index+match[0].length
 }
 query.append(statement.raw(text.slice(offset)))
 return {rows:await tx.execute(query)}
}
