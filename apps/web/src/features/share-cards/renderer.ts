// 渲染器的目标中立部分：字体组装与实例内缓存、回退字体（Noto Sans SC）按需加载、并发上限。
// 目标实现（Workers：server/cloudflare/share-card-renderer.ts；Node：node/share-card-renderer.ts）
// 只提供图片引擎与字体来源，本模块不导入 satori / resvg。
import { AppError } from '@saas/shared'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH } from './layout.tsx'
import { needsFallbackFont } from './text.ts'

export interface ShareCardFont {
  readonly name: string
  readonly data: ArrayBuffer
  readonly weight: 400 | 500 | 600 | 700
  readonly style: 'normal'
}

/** cf-workers-og 的 `ImageResponse.create`（Workers 或 Node 入口）。 */
export type ShareCardImageEngine = (
  element: ReactElement,
  options: { width: number; height: number; fonts: ShareCardFont[] },
) => Promise<Response>

export interface ShareCardRenderer {
  /** 渲染 1200×630 PNG；同一实例并发超限时抛出 503 的 AppError（code 为 SHARE_CARD_BUSY）。 */
  render(element: ReactElement): Promise<Uint8Array>
}

export const SHARE_CARD_BUSY = 'SHARE_CARD_BUSY'
export const SHARE_CARD_MAX_CONCURRENT = 2
export const CJK_FONT_FILE = 'NotoSansSC-Regular.otf'
export const LATIN_FONT_FILES = [
  { file: 'inter-latin-400-normal.woff.bin', weight: 400 },
  { file: 'inter-latin-600-normal.woff.bin', weight: 600 },
] as const

export interface ShareCardRendererOptions {
  readonly engine: ShareCardImageEngine
  /** 西文字体（随包或本地文件），首次渲染时读取一次。 */
  readonly loadLatinFonts: () => Promise<ShareCardFont[]> | ShareCardFont[]
  /** 完整 CJK 字体字节（Noto Sans SC，同时覆盖西里尔、希腊与扩展拉丁）；只在文本含 Inter Latin 子集之外的字符时调用，成功后实例内缓存。 */
  readonly loadCjkFont: () => Promise<ArrayBuffer>
  readonly maxConcurrent?: number
}

/** 收集元素树中的文本；函数组件会被调用一次以取得其输出的文字。 */
export function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint')
    return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    if (typeof node.type === 'function') {
      return collectText((node.type as (props: unknown) => ReactNode)(node.props))
    }
    return collectText(node.props.children)
  }
  return ''
}

export function createShareCardRenderer(options: ShareCardRendererOptions): ShareCardRenderer {
  const maxConcurrent = options.maxConcurrent ?? SHARE_CARD_MAX_CONCURRENT
  let active = 0
  // 字体数组在实例内复用：西文与 CJK 各读取一次，之后每次渲染传入同一批 ArrayBuffer。
  let latin: Promise<ShareCardFont[]> | undefined
  let withCjk: Promise<ShareCardFont[]> | undefined

  const latinFonts = () => {
    latin ??= Promise.resolve(options.loadLatinFonts()).catch((error: unknown) => {
      latin = undefined
      throw error
    })
    return latin
  }
  const cjkFonts = () => {
    withCjk ??= Promise.all([latinFonts(), options.loadCjkFont()])
      .then(([fonts, data]) => [
        ...fonts,
        { name: 'Noto Sans SC', data, weight: 400 as const, style: 'normal' as const },
      ])
      .catch((error: unknown) => {
        // 读取失败不缓存，下一次请求重试
        withCjk = undefined
        throw error
      })
    return withCjk
  }

  return {
    async render(element) {
      if (active >= maxConcurrent) {
        throw new AppError(SHARE_CARD_BUSY, 'Share card renderer is busy', {
          status: 503,
          publicDetails: { retryAfter: 1 },
        })
      }
      active += 1
      try {
        const fonts = await (needsFallbackFont(collectText(element)) ? cjkFonts() : latinFonts())
        const response = await options.engine(element, {
          width: SHARE_CARD_WIDTH,
          height: SHARE_CARD_HEIGHT,
          fonts,
        })
        if (!response.ok) throw new Error(`Share card render failed: ${response.status}`)
        return new Uint8Array(await response.arrayBuffer())
      } finally {
        active -= 1
      }
    },
  }
}
