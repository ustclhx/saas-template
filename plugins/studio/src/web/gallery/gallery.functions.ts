// 公开画廊与作品页的数据入口。服务端模块在处理函数内按需加载，查询代码不进入客户端包。
import { AppError } from '@saas/shared'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const NOT_FOUND = 404

/** 公开查询的 404（不存在、越界页、非公开作品）交给路由渲染未找到界面，文档请求得到 404 */
async function publicRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof AppError && error.status === NOT_FOUND) throw notFound()
    throw error
  }
}

export const getGalleryPage = createServerFn({ method: 'GET' })
  // 页码等形状只做宽松校验：非法值由公开查询按 404 处理，而不是校验失败变成 500
  .inputValidator(
    z.object({
      kind: z.enum(['image', 'video']).optional(),
      sort: z.literal('featured').optional(),
      page: z.number().optional(),
      cursor: z.string().max(200).optional(),
    }),
  )
  .handler(({ data }) =>
    publicRead(async () => (await import('./gallery.server.ts')).loadGalleryPage(data)),
  )

export const getWorkPage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ slug: z.string().max(200) }))
  .handler(({ data }) =>
    publicRead(async () => (await import('./gallery.server.ts')).loadWorkPage(data.slug)),
  )

export type GalleryPageData = Awaited<ReturnType<typeof getGalleryPage>>
export type WorkPageData = Awaited<ReturnType<typeof getWorkPage>>
export type GalleryWork = GalleryPageData['works'][number]
export type PublicWork = WorkPageData['work']
