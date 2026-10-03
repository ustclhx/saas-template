import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

/** Hyperdrive 绑定中本包用到的部分；与 workers-types 的 `Hyperdrive` 结构兼容。 */
export interface HyperdriveBinding {
  readonly connectionString: string
}

/**
 * 按请求创建数据库客户端：每个请求或事件调用一次 `createDb(env.HYPERDRIVE)`，
 * 不要缓存到模块作用域（Worker 的 I/O 对象不能跨请求复用）。
 */
export function createDb(hyperdrive: HyperdriveBinding) {
  const sql = postgres(hyperdrive.connectionString, {
    max: 5, // 单个 Worker 调用内的并发连接数
    fetch_types: false, // 省掉一次类型查询往返
    prepare: true,
  })
  return drizzle(sql, { schema })
}

export type Database = ReturnType<typeof createDb>
