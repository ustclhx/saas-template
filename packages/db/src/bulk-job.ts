import { BULK_JOB_TIME_FLOOR } from '@saas/shared/bulk-job'
import { type SQL, sql } from 'drizzle-orm'
import type { Database } from './client.ts'

/** SQL 中的时间下限常量，供候选查询过滤与区间外行计数使用 */
export const bulkJobFloorSql = sql`${BULK_JOB_TIME_FLOOR.toISOString()}::timestamptz`

/**
 * 删除类任务每轮开始时的探测：在同一条语句中取数据库时钟与区间外候选行数（add-ops-safeguards D3）。
 * 只在已有的定时任务里执行，不新增调度；`outOfRange` 为返回单个整数的子查询。
 */
export async function probeBulkJob(
  db: Pick<Database, 'execute'>,
  outOfRange?: SQL,
): Promise<{ dbNow: Date; outOfRange: number }> {
  const [row] = await db.execute<{ db_now: string | Date; out_of_range: number | string }>(
    sql`select now() as db_now, (${outOfRange ?? sql`0`})::int as out_of_range`,
  )
  return { dbNow: new Date(row?.db_now ?? Number.NaN), outOfRange: Number(row?.out_of_range ?? 0) }
}
