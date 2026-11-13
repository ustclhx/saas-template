import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { getWebRuntime } from '../../server/runtime.ts'
import { isUiPreviewEnabled } from '../ui-preview/gate.ts'
import { invalidateShareCard } from './invalidate.server.ts'
import { defaultShareCardLayout, sampleShareCardLayout } from './layout.tsx'
import { registerPreviewShareCards } from './meta.server.ts'
import { renderShareCard } from './render.server.ts'
import { SHARE_CARD_BUSY } from './renderer.ts'
import {
  addSampleShare,
  SAMPLE_SHARE_PREVIEWS,
  SAMPLE_SHARE_WORKSPACE_ID,
  type SampleSharePreview,
} from './sample.ts'
import { resolveShareCardTheme } from './theme.ts'
import { createShareToken } from './token.ts'

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })

/**
 * /dev/ui 分享卡片预览图（tasks 6.1）：用示例固定数据与真实渲染器输出 PNG，不读写存储与缓存。
 * 与 /dev/ui 同一开关（`UI_PREVIEW=true`），生产 404。
 */
export async function handleShareCardPreviewRequest(request: Request): Promise<Response> {
  if (!isUiPreviewEnabled(getWebRuntime().config)) return plain(404, 'Not Found')
  const url = new URL(request.url)
  const variant = url.searchParams.get('variant') ?? ''
  const mode = url.searchParams.get('mode') === 'dark' ? 'dark' : 'light'
  if (!Object.hasOwn(SAMPLE_SHARE_PREVIEWS, variant)) return plain(404, 'Not Found')
  const data = SAMPLE_SHARE_PREVIEWS[variant as SampleSharePreview]
  try {
    const body = await renderShareCard(
      {
        render: (value, theme) =>
          variant === 'default'
            ? defaultShareCardLayout(value.title, theme)
            : sampleShareCardLayout(value, theme),
      },
      data,
      resolveShareCardTheme(mode),
    )
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof AppError && error.code === SHARE_CARD_BUSY)
      return plain(503, 'Busy', { 'retry-after': '1' })
    log.error('share-cards.preview-failed', { error })
    return plain(500, 'Error')
  }
}

/**
 * 开发环境 e2e 夹具（tasks 6.2）：`create` 在内存中登记一条新的示例分享并返回令牌与分享页地址；
 * `invalidate` 调用模板失效函数（与项目撤销分享时相同）。调用方用 devOnly 包裹，生产构建 404。
 */
export async function handleSampleShareFixture(request: Request): Promise<Response> {
  const runtime = getWebRuntime()
  registerPreviewShareCards(runtime.config)
  const input = (await request.json().catch(() => null)) as {
    action?: string
    token?: string
  } | null
  if (input?.action === 'create') {
    const token = addSampleShare(createShareToken(), SAMPLE_SHARE_PREVIEWS.en)
    return Response.json({ token, page: `/s/sample/${token}` })
  }
  if (input?.action === 'invalidate' && typeof input.token === 'string') {
    await invalidateShareCard({
      type: 'sample',
      token: input.token,
      workspaceId: SAMPLE_SHARE_WORKSPACE_ID,
    })
    return Response.json({ invalidated: true })
  }
  return plain(400, 'Bad Request')
}
