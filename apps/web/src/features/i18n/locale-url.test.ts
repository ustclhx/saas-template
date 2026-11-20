import { describe, expect, it, vi } from 'vitest'
import { isPrerenderedPath, prerenderEntryPages } from '../marketing/prerender.ts'
import { textDirection } from './direction.ts'
import {
  canonicalLocalePath,
  localePath,
  localeRedirect,
  localeUrlPatterns,
  pageXDefaultLocale,
  prefixLocale,
  requestLocaleRouting,
  siteOfHost,
  siteRouting,
  xDefaultLocale,
} from './locale-url.ts'

// 模板默认只有 en / zh，这里用含大写字母的语言 id 夹具覆盖小写前缀（ML-01）
const routing = { locales: ['en', 'zh', 'zh-Hant', 'ar'], defaultLocale: 'en' }
const target = (path: string) => canonicalLocalePath(new URL(path, 'https://example.com'), routing)

describe('语言前缀规范化（multilingual-seo 2.2）', () => {
  it('默认语言前缀 301 到无前缀地址，保留查询串，大小写不限', () => {
    expect(target('/en/pricing')).toBe('/pricing')
    expect(target('/en')).toBe('/')
    expect(target('/en/')).toBe('/')
    expect(target('/EN/blog/welcome?utm_source=x&a=1')).toBe('/blog/welcome?utm_source=x&a=1')
  })

  it('大小写不同的前缀 301 到小写前缀', () => {
    expect(target('/zh-Hant/pricing')).toBe('/zh-hant/pricing')
    expect(target('/ZH-HANT')).toBe('/zh-hant')
    expect(target('/Zh/docs?q=1')).toBe('/zh/docs?q=1')
  })

  it('已是唯一地址、未配置前缀或普通路径不跳转', () => {
    for (const path of ['/', '/pricing', '/zh/pricing', '/zh-hant/pricing', '/fr/pricing', '/zhx'])
      expect(target(path), path).toBeNull()
  })

  it('只看路径：请求头不影响结果，非 GET/HEAD 不跳转', () => {
    const headers = { 'accept-language': 'zh-CN', cookie: 'PARAGLIDE_LOCALE=zh' }
    const response = localeRedirect(
      new Request('https://example.com/en/pricing?x=1', { headers }),
      routing,
    )
    expect(response?.status).toBe(301)
    expect(response?.headers.get('location')).toBe('/pricing?x=1')
    expect(response?.headers.get('set-cookie')).toBeNull()
    expect(
      localeRedirect(new Request('https://example.com/en/pricing', { method: 'HEAD' }), routing)
        ?.status,
    ).toBe(301)
    expect(
      localeRedirect(new Request('https://example.com/en/x', { method: 'POST' }), routing),
    ).toBeNull()
    expect(
      localeRedirect(new Request('https://example.com/zh/pricing', { headers }), routing),
    ).toBeNull()
  })

  it('URL 规则：非默认语言小写前缀在前，默认语言通配在最后；只差大小写的语言 id 报错', () => {
    const origin = ':protocol://:domain(.*)::port?'
    expect(localeUrlPatterns(routing)).toEqual([
      {
        pattern: `${origin}/:path(.*)?`,
        localized: [
          ['zh', `${origin}/zh/:path(.*)?`],
          ['zh-Hant', `${origin}/zh-hant/:path(.*)?`],
          ['ar', `${origin}/ar/:path(.*)?`],
          ['en', `${origin}/:path(.*)?`],
        ],
      },
    ])
    expect(() =>
      localeUrlPatterns({ locales: ['en', 'zh-hant', 'zh-Hant'], defaultLocale: 'en' }),
    ).toThrow(/前缀冲突/)
    expect(prefixLocale('ZH-hant', routing.locales)).toBe('zh-Hant')
    expect(prefixLocale('', routing.locales)).toBeUndefined()
  })

  it('预渲染入口与范围使用小写前缀，静态输出中没有默认语言前缀目录', () => {
    expect(prerenderEntryPages(routing.locales, routing.defaultLocale)).toEqual([
      { path: '/' },
      { path: '/zh' },
      { path: '/zh-hant' },
      { path: '/ar' },
    ])
    expect(isPrerenderedPath('/zh-hant/blog/welcome', routing.locales)).toBe(true)
    expect(isPrerenderedPath('/zh-hant', routing.locales)).toBe(true)
    expect(isPrerenderedPath('/zh-hant/pricing', routing.locales)).toBe(false)
  })
})

describe('页面书写方向（multilingual-seo 2.3）', () => {
  it('从右到左的语言输出 rtl，其他语言 ltr', () => {
    for (const locale of ['ar', 'fa', 'he', 'ur', 'ar-EG', 'ckb'])
      expect(textDirection(locale)).toBe('rtl')
    for (const locale of ['en', 'zh', 'zh-Hant', 'ja', 'fr'])
      expect(textDirection(locale)).toBe('ltr')
  })

  it('运行时不支持 Intl.Locale 文本信息或标签非法时按内置 RTL 表兜底', () => {
    // 模拟没有 getTextInfo / textInfo 的运行时
    vi.stubGlobal('Intl', {
      ...Intl,
      Locale: class extends Intl.Locale {
        getTextInfo = undefined
        textInfo = undefined
      },
    })
    try {
      for (const locale of ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'ar-SA'])
        expect(textDirection(locale), locale).toBe('rtl')
      expect(textDirection('en')).toBe('ltr')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(textDirection('not a locale!')).toBe('ltr')
  })
})

// 多站点（0.8.1）：站点各有默认语言，地址规范化、前缀生成与 x-default 都按站点取
describe('多站点地址规则与 x-default', () => {
  const i18n = { locales: ['en', 'zh-Hant', 'zh-Hans', 'ko'], defaultLocale: 'en' }
  const west = { locales: ['en'] }
  const east = { locales: ['zh-Hant', 'zh-Hans', 'ko'], defaultLocale: 'zh-Hant' }
  const at = (path: string, routing: Parameters<typeof canonicalLocalePath>[1]) =>
    canonicalLocalePath(new URL(path, 'https://example.com'), routing)

  it('siteRouting：声明的 defaultLocale 优先，省略时站点含全局默认语言才有无前缀语言', () => {
    expect(siteRouting(east, i18n)).toEqual({
      locales: ['zh-Hant', 'zh-Hans', 'ko'],
      defaultLocale: 'zh-Hant',
    })
    expect(siteRouting({ ...east, defaultLocale: undefined }, i18n).defaultLocale).toBeNull()
    expect(siteRouting({ ...east, defaultLocale: null }, i18n).defaultLocale).toBeNull()
    expect(siteRouting(west, i18n)).toEqual({ locales: ['en'], defaultLocale: 'en' })
    // 隐含站点：未列入分组的语言；未配置分组时与 i18n 相同（单站点行为不变）
    expect(siteRouting(undefined, i18n, [east])).toEqual({ locales: ['en'], defaultLocale: 'en' })
    expect(siteRouting(undefined, i18n)).toEqual(i18n)
  })

  it('按站点规范化：站点默认语言前缀 301，其他站点语言的前缀原样放行', () => {
    const routing = siteRouting(east, i18n)
    expect(at('/zh-hant/daily?d=1', routing)).toBe('/daily?d=1')
    expect(at('/ZH-HANT', routing)).toBe('/')
    expect(at('/ZH-Hans/x', routing)).toBe('/zh-hans/x')
    // 全局默认语言 en 不属于本站点：不跳到 /
    expect(at('/en', routing)).toBeNull()
    expect(at('/en/pricing', routing)).toBeNull()
    // 没有无前缀语言的站点只做大小写规范化
    const prefixed = siteRouting({ ...east, defaultLocale: null }, i18n)
    expect(at('/zh-hant/x', prefixed)).toBeNull()
    expect(at('/Ko', prefixed)).toBe('/ko')
    expect(
      localeRedirect(new Request('https://e.example/zh-hant/a'), routing)?.headers.get('location'),
    ).toBe('/a')
  })

  it('按请求 Host 选站点：hosts 或 previewHost 匹配（忽略端口与大小写），未匹配时按全局 i18n', () => {
    const sites = [
      { ...west, hosts: ['west.example.com'], previewHost: 'west.localhost' },
      { ...east, defaultLocale: null, hosts: ['east.example.com', 'www.east.example.com'] },
    ]
    const redirect = (url: string) => {
      const request = new Request(url)
      const routing = requestLocaleRouting(new URL(url), i18n, sites)
      const response = localeRedirect(request, routing)
      return response ? `${response.status} ${response.headers.get('location')}` : null
    }
    // 东方站没有 en：/en 不跳（项目自有的东方站英文入口），大写前缀仍规范为小写
    expect(redirect('https://east.example.com/en')).toBeNull()
    expect(redirect('https://www.east.example.com/en/pricing')).toBeNull()
    expect(redirect('https://EAST.example.com:8443/ZH-Hant/x')).toBe('301 /zh-hant/x')
    // 西方站 en 为默认语言：/en 301 到 /
    expect(redirect('https://west.example.com/en/pricing?a=1')).toBe('301 /pricing?a=1')
    expect(redirect('http://west.localhost:4173/en')).toBe('301 /')
    // 未登记的 Host（staging、预览）与未配置分组：全局 i18n，与单站点相同
    expect(redirect('https://staging.example.net/en')).toBe('301 /')
    expect(redirect('https://staging.example.net/zh-hant/x')).toBeNull()
    expect(requestLocaleRouting(new URL('https://a.example/'), i18n, [])).toBe(i18n)
    expect(siteOfHost('', sites)).toBeUndefined()
    expect(siteOfHost('east.example.com.', sites)).toBe(sites[1])
  })

  it('localePath：站点默认语言无前缀，其余小写前缀', () => {
    expect(localePath('/daily/', 'zh-Hant', 'zh-Hant')).toBe('/daily')
    expect(localePath('/', 'ko', 'zh-Hant')).toBe('/ko')
    expect(localePath('/daily', 'zh-Hans', null)).toBe('/zh-hans/daily')
    expect(localePath('/', 'en', 'en')).toBe('/')
  })

  it('x-default：偏好列表中本页存在的第一个语言，否则站点默认、全局默认与配置顺序', () => {
    expect(xDefaultLocale(['zh-Hans', 'ko'], { preference: ['zh-Hant', 'ko'] })).toBe('ko')
    expect(xDefaultLocale(['zh-Hans', 'ko'], { preference: ['ZH-HANS'] })).toBe('zh-Hans')
    expect(xDefaultLocale(['zh', 'en'], { defaultLocale: 'en', locales: ['zh', 'en'] })).toBe('en')
    expect(xDefaultLocale(['ko', 'zh'], { locales: ['zh', 'ko'] })).toBe('zh')
    expect(xDefaultLocale(['ja'], {})).toBe('ja')
    expect(xDefaultLocale([], {})).toBeUndefined()

    const linking = { sites: [west, { ...east, xDefaultLocales: ['ko'] }], xDefaultLocales: [] }
    // 站点偏好覆盖全局；按本页语言选站点
    expect(pageXDefaultLocale(['zh-Hant', 'ko'], 'zh-Hant', i18n, linking)).toBe('ko')
    // 站点默认语言先于全局默认语言与配置顺序
    const noPreference = { sites: [west, east], xDefaultLocales: [] }
    expect(pageXDefaultLocale(['zh-Hans', 'zh-Hant'], 'zh-Hans', i18n, noPreference)).toBe(
      'zh-Hant',
    )
    // 单站点（未配置分组）：默认语言版本，否则按配置顺序（0.8.0 行为）
    const single = { sites: [], xDefaultLocales: [] }
    expect(pageXDefaultLocale(['zh-Hans', 'en'], 'zh-Hans', i18n, single)).toBe('en')
    expect(pageXDefaultLocale(['ko', 'zh-Hans'], 'ko', i18n, single)).toBe('zh-Hans')
    expect(
      pageXDefaultLocale(['ko', 'en'], undefined, i18n, { sites: [], xDefaultLocales: ['ko'] }),
    ).toBe('ko')
  })
})
