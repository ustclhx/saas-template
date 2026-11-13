import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

/**
 * 通用分享页数据（design 第 8 条）。有效时返回卡片、标题与描述；未注册、`sharePage: false`、
 * 撤销、格式不符、解析为空与到期都抛出 notFound（附原因，页面据此区分「不存在」与「已过期」文案），
 * 文档请求因此得到 404。服务端模块在处理函数内按需加载，分享注册与项目解析不进入客户端包。
 */
export const getSharePage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ type: z.string().min(1).max(256), token: z.string().min(1).max(256) }))
  .handler(async ({ data }) => {
    const { loadSharePage } = await import('./page.server.ts')
    const view = await loadSharePage(data)
    if (view.status === 'not-found' || view.status === 'expired')
      throw notFound({ data: { reason: view.status } })
    return view
  })
