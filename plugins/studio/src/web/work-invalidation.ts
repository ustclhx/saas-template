import type { StudioWork } from '@saas/db'
import { log } from '@saas/shared/log'
import { studioMediaPath } from './media-url.ts'

export type StudioWorkAddress = Pick<StudioWork, 'id' | 'slug' | 'site' | 'version'>
export type InvalidateStudioWork = (work: StudioWorkAddress) => void | Promise<void>

interface InvalidationOptions {
  originForSite(site: string): string | undefined
  cache?: { delete(url: string): Promise<boolean> }
  purge?: { token?: string | undefined; zoneId?: string | undefined }
  fetch?: typeof fetch
}

export function createStudioWorkInvalidator({
  originForSite,
  cache,
  purge,
  fetch: request = globalThis.fetch,
}: InvalidationOptions): InvalidateStudioWork {
  const { token, zoneId } = purge ?? {}
  return async ({ id, site, version }) => {
    if (!cache && !(token && zoneId)) return
    const origin = originForSite(site)
    if (!origin) return
    const url = new URL(studioMediaPath(id, version), origin).href
    const fields = { workId: id, version }

    const deleteLocal = async () => {
      try {
        await cache?.delete(url)
      } catch (error) {
        log.warn('studio.media.cache_delete_failed', {
          ...fields,
          errorName: error instanceof Error ? error.name : typeof error,
        })
      }
    }
    const purgeGlobal = async () => {
      if (!token || !zoneId) return
      try {
        const response = await request(
          `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: [url] }),
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
          },
        )
        if (!response.ok) {
          log.warn('studio.media.purge_failed', { ...fields, status: response.status })
          await response.body?.cancel()
          return
        }
        const result: unknown = await response.json()
        if ((result as { success?: unknown } | null)?.success !== true)
          log.warn('studio.media.purge_failed', { ...fields, status: response.status })
      } catch (error) {
        log.warn('studio.media.purge_failed', {
          ...fields,
          errorName: error instanceof Error ? error.name : typeof error,
        })
      }
    }
    await Promise.all([deleteLocal(), purgeGlobal()])
  }
}

let mediaInvalidator: InvalidateStudioWork | undefined

/** 由 Worker 或 Node 启动入口装配；回调只在变更事务提交后运行。 */
export function setStudioMediaInvalidator(invalidate: InvalidateStudioWork): void {
  mediaInvalidator = invalidate
}

export const invalidateStudioMedia: InvalidateStudioWork = (work) =>
  invalidateStudioWork(work, mediaInvalidator)

/** 提交后通知缓存失效。数据库已生效，边缘清除失败依照设计的 TTL 过期。 */
export async function invalidateStudioWork(
  work: StudioWorkAddress,
  invalidate?: InvalidateStudioWork,
) {
  if (!invalidate) return
  const { id, site, slug, version } = work
  try {
    await invalidate({ id, site, slug, version })
  } catch (error) {
    log.warn('studio.work.invalidate_failed', {
      workId: id,
      version,
      errorName: error instanceof Error ? error.name : typeof error,
    })
  }
}
