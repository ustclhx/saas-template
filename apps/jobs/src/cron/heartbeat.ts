import type { Env } from '@saas/config'
import { createDb, recordLastCronAt } from '@saas/db'

/** 每 5 分钟的心跳 Cron（wrangler.jsonc 的 triggers.crons） */
export const HEARTBEAT_CRON = '*/5 * * * *'

/**
 * 记录最近一次成功运行的时间，供 `/api/health` 的 `jobs.lastCronAt` 判断定时任务是否停摆
 * （specs/system-health「后台 Worker 心跳」）。
 *
 * 不调用 `sql.end()`：postgres.js 3.4.9 在 workerd 中关闭连接会抛出无法捕获的
 * 「Stream was cancelled」；连接随事件结束由 workerd 回收（与 apps/web 的健康检查一致）。
 */
export async function runHeartbeat(env: Env, now: Date = new Date()): Promise<void> {
  await recordLastCronAt(createDb(env.HYPERDRIVE), now)
  console.log(JSON.stringify({ event: 'cron.heartbeat', at: now.toISOString() }))
}
