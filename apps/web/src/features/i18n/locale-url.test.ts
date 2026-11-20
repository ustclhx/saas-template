import { describe, expect, it, vi } from 'vitest'
import { isPrerenderedPath, prerenderEntryPages } from '../marketing/prerender.ts'
import { textDirection } from './direction.ts'
import {
  canonicalLocalePath,
  localeRedirect,
  localeUrlPatterns,
  prefixLocale,
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
