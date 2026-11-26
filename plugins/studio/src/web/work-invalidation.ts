import type { StudioWork } from '@saas/db'
import { log } from '@saas/shared/log'

export type StudioWorkAddress = Pick<StudioWork, 'id' | 'slug' | 'site' | 'version'>
export type InvalidateStudioWork = (work: StudioWorkAddress) => void | Promise<void>

let mediaInvalidator: InvalidateStudioWork | undefined

/** 由 Worker 或 Node 启动入口装配；回调只在变更事务提交后运行。 */
export function setStudioMediaInvalidator(invalidate: InvalidateStudioWork): void {
  mediaInvalidator = invalidate
}

/** 提交后通知缓存失效。数据库已生效，边缘清除失败依照设计的 TTL 过期。 */
export async function invalidateStudioWork(
  work: StudioWorkAddress,
  invalidate: InvalidateStudioWork | undefined = mediaInvalidator,
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
