// 公开画廊与作品页的地址规则（design 决策 4、5）。纯函数，服务端与浏览器共用。
import type { StudioKind } from '../../kinds.ts'

export interface GallerySearch {
  kind?: StudioKind | undefined
  sort?: 'featured' | undefined
  page?: number | undefined
  cursor?: string | undefined
}

const KIND_VALUES: readonly string[] = ['image', 'video']

/**
 * 查询参数只做形状整理：未知类型与排序丢弃（canonical 仍指向无参数的第一页），页码保留原值，
 * 由公开查询判定越界与非法值（返回 404）。
 */
export function parseGallerySearch(search: Record<string, unknown>): GallerySearch {
  const kind =
    typeof search.kind === 'string' && KIND_VALUES.includes(search.kind) ? search.kind : undefined
  const rawPage = search.page
  const parsed =
    typeof rawPage === 'number'
      ? rawPage
      : typeof rawPage === 'string' && rawPage !== ''
        ? Number(rawPage)
        : undefined
  // 非数字页码记为 0：公开查询按越界返回 404（NaN 无法经 server function 序列化）
  const page = parsed === undefined ? undefined : Number.isFinite(parsed) ? parsed : 0
  return {
    ...(kind !== undefined && { kind: kind as StudioKind }),
    ...(search.sort === 'featured' && { sort: 'featured' as const }),
    ...(page !== undefined && page !== 1 && { page }),
    ...(typeof search.cursor === 'string' && search.cursor !== '' && { cursor: search.cursor }),
  }
}

/** 画廊地址：参数顺序固定，第一页不带 page，便于边缘缓存命中同一个键。 */
export function galleryHref(search: GallerySearch = {}): string {
  const params = new URLSearchParams()
  if (search.kind) params.set('kind', search.kind)
  if (search.sort) params.set('sort', search.sort)
  if (search.page !== undefined && search.page !== 1) params.set('page', String(search.page))
  if (search.cursor) params.set('cursor', search.cursor)
  const query = params.toString()
  return query ? `/gallery?${query}` : '/gallery'
}

/** 带类型、排序或游标的地址指向无参数的第一页；只带 page 的地址指向自身。 */
export function galleryCanonicalPath(search: GallerySearch): string {
  if (search.kind || search.sort || search.cursor) return '/gallery'
  return galleryHref({ ...(search.page !== undefined && { page: search.page }) })
}

export function workPath(slug: string): string {
  return `/gallery/${encodeURIComponent(slug)}`
}

/** 做同款入口：服务端按登录状态跳转登录页或当前空间的创作页（不进入边缘缓存）。 */
export function remixPath(slug: string): string {
  return `/gallery/remix/${encodeURIComponent(slug)}`
}

/** 创作页预填地址；提示词只在作者公开时带上。 */
export function studioRemixHref(
  workspaceSlug: string,
  work: { modelKey: string; prompt: string | null },
): string {
  const params = new URLSearchParams({ model: work.modelKey })
  if (work.prompt) params.set('prompt', work.prompt)
  return `/app/${encodeURIComponent(workspaceSlug)}/studio?${params.toString()}`
}

/** 视频时长角标：m:ss */
export function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 作品页与站点地图日期：UTC 日期，避免服务端与浏览器时区不同导致水合差异 */
export function formatPublishedDate(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10)
}
