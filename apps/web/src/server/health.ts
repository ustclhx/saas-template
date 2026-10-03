import {
  createDb,
  type Database,
  type HyperdriveBinding,
  pingDatabase,
  readLastCronAt,
} from '@saas/db'

/** 数据库探测超过该时间视为不可达（specs/system-health） */
export const HEALTH_DB_TIMEOUT_MS = 5_000

export interface HealthOptions {
  /** 必须是不带查询缓存的 `HYPERDRIVE` 绑定，不能用 `HYPERDRIVE_CACHED` */
  hyperdrive: HyperdriveBinding
  version: string
  timeoutMs?: number
}

export type HealthBody =
  | {
      status: 'ok'
      version: string
      db: { status: 'up'; latencyMs: number }
      jobs: { lastCronAt: string | null }
    }
  | {
      status: 'error'
      version: string
      db: { status: 'down' }
    }

class ProbeTimeoutError extends Error {
  override readonly name = 'ProbeTimeoutError'
}

/**
 * `GET /api/health` 的实现：一次 `select 1` 往返计时，再读取实时的 `jobs.lastCronAt`
 * （不经过 getSetting 的 KV 缓存）。整个探测超过 `timeoutMs` 或任一步失败时返回 503，
 * 响应与日志都不包含连接串、主机名或驱动的错误消息。
 *
 * 不调用 `sql.end()`：postgres.js 3.4.9 在 workerd 中关闭连接时会抛出无法捕获的
 * 「Stream was cancelled」（cf/polyfills.js 中 `socket.close()` 的 promise 未被处理）。
 * 连接随请求结束由 workerd 回收，Hyperdrive 在边缘维护连接池，因此按请求创建、不显式关闭。
 */
export async function healthResponse({
  hyperdrive,
  version,
  timeoutMs = HEALTH_DB_TIMEOUT_MS,
}: HealthOptions): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  try {
    const db = createDb(hyperdrive)
    const { latencyMs, lastCronAt } = await withTimeout(probe(db), timeoutMs)
    const body: HealthBody = {
      status: 'ok',
      version,
      db: { status: 'up', latencyMs },
      jobs: { lastCronAt },
    }
    return Response.json(body, { headers })
  } catch (error) {
    console.error(JSON.stringify({ event: 'health.db_down', reason: describe(error) }))
    const body: HealthBody = { status: 'error', version, db: { status: 'down' } }
    return Response.json(body, { status: 503, headers })
  }
}

async function probe(db: Database) {
  const started = performance.now()
  await pingDatabase(db)
  const latencyMs = Math.round(performance.now() - started)
  const lastCronAt = await readLastCronAt(db)
  return { latencyMs, lastCronAt }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // 超时后探测仍可能失败，避免它成为未处理的 rejection
  promise.catch(() => {})
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 只记录错误类别（超时 / 错误码），驱动的错误消息里可能带主机名与端口。 */
function describe(error: unknown): string {
  if (error instanceof ProbeTimeoutError) return 'timeout'
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code
  return 'error'
}
