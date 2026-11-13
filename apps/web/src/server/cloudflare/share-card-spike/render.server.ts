// add-og-images 1.1 可行性验证的临时渲染器，只供测量，不进入正式实现。
// 由路由处理函数动态 import()，WASM、satori 与字体只在本路由首次请求时实例化。
import { env } from 'cloudflare:workers'
import { CustomFont, ImageResponse } from 'cf-workers-og'
import { createElement } from 'react'
import inter400 from './fonts/inter-latin-400-normal.woff.bin'
import inter700 from './fonts/inter-latin-700-normal.woff.bin'

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/
const CJK_FONT_PATH = '/fonts/share-card/NotoSansSC-Regular.otf'
// 模块求值属于全局作用域，不能生成随机数；首个请求时再生成实例标识
let isolateId: string | undefined
let renders = 0
// 实例内缓存解析后的 CJK 字体字节；首个含 CJK 的请求读取一次
let cjkFont: Promise<ArrayBuffer> | undefined

function loadCjkFont(origin: string): Promise<ArrayBuffer> {
  const pending =
    cjkFont ??
    env.ASSETS.fetch(new Request(new URL(CJK_FONT_PATH, origin))).then((res) => {
      if (!res.ok) throw new Error(`CJK font ${res.status}`)
      return res.arrayBuffer()
    })
  cjkFont = pending
  return pending
}

function truncate(text: string, max: number) {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

function card(title: string, subtitle: string, brand: string) {
  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        padding: 72,
        color: '#0f172a',
        background: '#ffffff',
        fontFamily: 'Inter, Noto Sans SC',
      },
    },
    createElement(
      'div',
      { style: { display: 'flex', fontSize: 32, fontWeight: 700, color: '#4f46e5' } },
      brand,
    ),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 24 } },
      createElement(
        'div',
        { style: { display: 'flex', fontSize: 64, fontWeight: 700, lineHeight: 1.2 } },
        truncate(title, 48),
      ),
      createElement(
        'div',
        { style: { display: 'flex', fontSize: 30, color: '#64748b', lineHeight: 1.4 } },
        truncate(subtitle, 90),
      ),
    ),
    createElement('div', { style: { display: 'flex', height: 8, background: '#4f46e5' } }),
  )
}

export async function renderSpike(request: Request): Promise<Response> {
  const t0 = Date.now()
  isolateId ??= crypto.randomUUID()
  const url = new URL(request.url)
  const title = url.searchParams.get('title') ?? 'Quarterly report is ready'
  const subtitle = url.searchParams.get('subtitle') ?? 'Generated summary of the latest results'
  const brand = url.searchParams.get('brand') ?? 'SaaS Template'
  const needsCjk = CJK.test(title + subtitle + brand)
  const fonts = [
    new CustomFont('Inter', inter400, { weight: 400 }),
    new CustomFont('Inter', inter700, { weight: 700 }),
  ]
  const coldFont = needsCjk && cjkFont === undefined
  if (needsCjk) {
    // 只有一个 CJK 字重：粗体标题由 satori 合成，验证阶段不额外加载
    const data = await loadCjkFont(url.origin)
    fonts.push(new CustomFont('Noto Sans SC', data, { weight: 400 }))
  }
  const t1 = Date.now()
  const image = await ImageResponse.create(card(title, subtitle, brand), {
    width: 1200,
    height: 630,
    fonts,
  })
  const body = await image.arrayBuffer()
  const t2 = Date.now()
  renders += 1
  return new Response(body, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      // 生产 Workers 在纯计算期间不推进计时器，以下耗时只在本地 workerd 有意义
      'x-spike-isolate': isolateId,
      'x-spike-render-index': String(renders),
      'x-spike-cjk': needsCjk ? (coldFont ? 'cold' : 'cached') : 'none',
      'x-spike-font-ms': String(t1 - t0),
      'x-spike-render-ms': String(t2 - t1),
    },
  })
}
