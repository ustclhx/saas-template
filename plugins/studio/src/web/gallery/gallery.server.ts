// 公开画廊与作品页的服务端读取（design 决策 4、6）。只在服务端执行：由 gallery.functions.ts 按需加载。

import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { getRequest } from '@tanstack/react-start/server'
import { readRequestSession } from '@web/features/i18n/session.server.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { studioConfigSchema } from '../../config.ts'
import { enabledStudioKinds, type StudioKind } from '../../kinds.ts'
import { getPublicWorkBySlug, listPublicWorks, listRelatedPublicWorks } from '../public-works.ts'
import { hasSessionCookie } from './page-cache.ts'
import type { GallerySearch } from './paths.ts'
import { studioPublicSite } from './site.server.ts'

/** 文档请求中读取失败（数据库不可达等）的请求：页面渲染带导航的错误界面，响应改为 503 且不缓存 */
const failedRequests = new WeakSet<Request>()

export function studioRequestFailed(request: Request): boolean {
  return failedRequests.has(request)
}

const NOT_FOUND = 404

function studioScope(request: Request) {
  const kinds = enabledStudioKinds(templateConfig)
  if (kinds.length === 0) throw new AppError('NOT_FOUND', 'Not found', { status: NOT_FOUND })
  if (pluginUnavailable(getWebRuntime(), 'studio'))
    throw new AppError('STUDIO_UNAVAILABLE', 'Studio is unavailable', { status: 503 })
  // 多站点：只读本站作品；请求来源不属于任何站点时一律 404（他站作品不可见）
  const site = studioPublicSite(request.url)
  if (!site) throw new AppError('NOT_FOUND', 'Not found', { status: NOT_FOUND })
  return { site: site.key, kinds, origin: site.origin }
}

/** 404 原样抛出；其余错误记日志、标记本次请求失败，并以 503 交给页面的错误界面 */
async function guarded<T>(event: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof AppError && error.status === NOT_FOUND) throw error
    log.error(event, { error })
    failedRequests.add(getRequest())
    throw new AppError('STUDIO_GALLERY_UNAVAILABLE', 'Gallery is unavailable', { status: 503 })
  }
}

/** 日期转为 ISO 字符串，经 server function 序列化后服务端与浏览器一致 */
function serializeCard<T extends { publishedAt: Date; featuredAt: Date | null }>(work: T) {
  return {
    ...work,
    publishedAt: work.publishedAt.toISOString(),
    featuredAt: work.featuredAt?.toISOString() ?? null,
  }
}

function galleryPageSize() {
  return studioConfigSchema.parse(templateConfig.plugins.studio ?? {}).galleryPageSize
}

export async function loadGalleryPage(search: GallerySearch) {
  const request = getRequest()
  return guarded('studio.gallery.load_failed', async () => {
    const { origin, ...scope } = studioScope(request)
    // 未启用的类型筛选与不存在的页面一样返回 404
    if (search.kind && !scope.kinds.includes(search.kind))
      throw new AppError('NOT_FOUND', 'Not found', { status: NOT_FOUND })
    const page = search.page ?? 1
    const result = await listPublicWorks(getWebRuntime().publicDb, {
      ...scope,
      pageSize: galleryPageSize(),
      page,
      ...(search.kind && { kind: search.kind }),
      ...(search.sort && { sort: search.sort }),
      ...(search.cursor && { cursor: search.cursor }),
    })
    return {
      // 站点规范来源：canonical、og 与结构化数据中的绝对地址按作品所在站点输出
      origin,
      kinds: scope.kinds as StudioKind[],
      page,
      works: result.works.map(serializeCard),
      nextPage: result.nextPage,
      nextCursor: result.nextCursor,
    }
  })
}

/** 已登录访客才查会话（判断是否为作者，显示待审核说明）；会话读取失败按访客处理 */
async function viewerUserId(request: Request): Promise<string | undefined> {
  if (!hasSessionCookie(request.headers.get('cookie'))) return undefined
  try {
    const runtime = getWebRuntime()
    const session = await readRequestSession({
      auth: runtime.auth,
      db: runtime.db,
      headers: request.headers,
    })
    return session.user.id
  } catch {
    return undefined
  }
}

export async function loadWorkPage(slug: string) {
  const request = getRequest()
  return guarded('studio.work.load_failed', async () => {
    const { origin, ...scope } = studioScope(request)
    const userId = await viewerUserId(request)
    const runtime = getWebRuntime()
    // 作品状态变化要尽快反映（取消发布、下架），详情不用带查询缓存的公开连接
    const work = await getPublicWorkBySlug(runtime.db, {
      ...scope,
      slug,
      ...(userId !== undefined && { viewerUserId: userId }),
    })
    if (!work) throw new AppError('NOT_FOUND', 'Not found', { status: NOT_FOUND })
    const related = await listRelatedPublicWorks(runtime.publicDb, {
      ...scope,
      kind: work.kind,
      workId: work.id,
    })
    return { origin, work: serializeCard(work), related: related.map(serializeCard) }
  })
}

/** 做同款：只读公开作品的模型与公开的提示词 */
export async function loadRemixTarget(request: Request, slug: string) {
  const { origin: _origin, ...scope } = studioScope(request)
  const work = await getPublicWorkBySlug(getWebRuntime().db, { ...scope, slug })
  return work ? { modelKey: work.modelKey, prompt: work.prompt } : null
}
