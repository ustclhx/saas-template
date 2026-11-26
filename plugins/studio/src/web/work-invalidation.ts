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

/**
 * Cloudflare 按 URL 清除时每次请求的上限：Free / Pro / Business 为 100，Enterprise 为 500，取 100。
 * 2026-11-26 核对：[Purge cache — Single-file purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/)
 */
export const PURGE_FILES_PER_REQUEST = 100

/** 单件失效回调，另带一次处理多件的 `many`（批量审核在循环结束后只调用一次） */
export type StudioWorkInvalidator = InvalidateStudioWork & { many: InvalidateStudioWorks }
export type InvalidateStudioWorks = (works: readonly StudioWorkAddress[]) => void | Promise<void>

export function createStudioWorkInvalidator({
  originForSite,
  cache,
  purge,
  fetch: request = globalThis.fetch,
}: InvalidationOptions): StudioWorkInvalidator {
  const { token, zoneId } = purge ?? {}

  const deleteLocal = async (url: string, fields: { workId: string; version: number }) => {
    try {
      await cache?.delete(url)
    } catch (error) {
      log.warn('studio.media.cache_delete_failed', {
        ...fields,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
  }
  const purgeGlobal = async (files: string[], fields: Record<string, unknown>) => {
    if (!token || !zoneId || files.length === 0) return
    try {
      const response = await request(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
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

  const many: InvalidateStudioWorks = async (works) => {
    if (!cache && !(token && zoneId)) return
    const targets = works.flatMap(({ id, site, version }) => {
      const origin = originForSite(site)
      return origin
        ? [{ url: new URL(studioMediaPath(id, version), origin).href, workId: id, version }]
        : []
    })
    const chunks: (typeof targets)[] = []
    for (let i = 0; i < targets.length; i += PURGE_FILES_PER_REQUEST)
      chunks.push(targets.slice(i, i + PURGE_FILES_PER_REQUEST))
    await Promise.all([
      ...targets.map(({ url, workId, version }) => deleteLocal(url, { workId, version })),
      ...chunks.map((chunk) =>
        purgeGlobal(
          chunk.map(({ url }) => url),
          chunk.length === 1
            ? { workId: chunk[0]?.workId, version: chunk[0]?.version }
            : { works: chunk.length },
        ),
      ),
    ])
  }
  const single = ((work: StudioWorkAddress) => many([work])) as StudioWorkInvalidator
  single.many = many
  return single
}

let mediaInvalidator: InvalidateStudioWork | StudioWorkInvalidator | undefined

/** 由 Worker 或 Node 启动入口装配；回调只在变更事务提交后运行。 */
export function setStudioMediaInvalidator(
  invalidate: InvalidateStudioWork | StudioWorkInvalidator,
): void {
  mediaInvalidator = invalidate
}

/** 批量失效：已装配的回调带 `many` 时一次处理（Cloudflare 清除按上限分片），否则逐件调用 */
export const invalidateStudioMediaMany: InvalidateStudioWorks = (works) => {
  const current = mediaInvalidator
  if (!current) return
  return invalidateStudioWorks(
    works,
    'many' in current
      ? current.many
      : async (list) => {
          for (const work of list) await invalidateStudioWork(work, current)
        },
  )
}

/** 提交后一次通知多件失效；失败只记日志，数据库已生效 */
export async function invalidateStudioWorks(
  works: readonly StudioWorkAddress[],
  invalidateMany?: InvalidateStudioWorks,
) {
  if (!invalidateMany || works.length === 0) return
  const addresses = works.map(({ id, site, slug, version }) => ({ id, site, slug, version }))
  try {
    await invalidateMany(addresses)
  } catch (error) {
    log.warn('studio.work.invalidate_failed', {
      works: addresses.length,
      errorName: error instanceof Error ? error.name : typeof error,
    })
  }
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
