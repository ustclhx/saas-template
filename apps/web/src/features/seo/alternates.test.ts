import { describe, expect, it } from 'vitest'
import { baseLocale, type Locale, locales, localizeHref } from '../../paraglide/runtime.js'
import {
  alternatesFromLinks,
  alternatesKey,
  languageOptions,
  parseAlternatesKey,
  routeLinks,
} from './alternates.ts'

const other = locales.find((locale) => locale !== baseLocale)

describe.runIf(other !== undefined)('本页语言版本与切换器选项（multilingual-seo 3.2、4.3）', () => {
  const target = (other ?? baseLocale) as Locale
  const encoded = `/${target.toLowerCase()}/${encodeURIComponent('四柱')}`
  const links = [
    { rel: 'canonical', href: 'https://app.example/four-pillars' },
    { rel: 'alternate', hrefLang: baseLocale, href: 'https://app.example/four-pillars' },
    { rel: 'alternate', hrefLang: target, href: `https://app.example${encoded}` },
    { rel: 'alternate', hrefLang: 'x-default', href: 'https://app.example/four-pillars' },
  ]

  it('从路由 head links 读取 hreflang（不含 x-default），只取 pathname；没有 hreflang 时为 null', () => {
    const alternates = alternatesFromLinks(routeLinks([{ links }, { links: undefined }]))
    expect(alternates).toEqual(
      new Map([
        [baseLocale, '/four-pillars'],
        [target, encoded],
      ]),
    )
    expect(parseAlternatesKey(alternatesKey(alternates))).toEqual(alternates)
    expect(alternatesFromLinks([{ rel: 'canonical', href: 'https://app.example/' }])).toBeNull()
    expect(parseAlternatesKey(alternatesKey(null))).toBeNull()
  })

  it('本地化 slug：切换器使用声明的地址，当前语言标记 current', () => {
    const alternates = alternatesFromLinks(links)
    expect(
      languageOptions({
        locale: baseLocale,
        pathname: '/four-pillars',
        alternates,
        appArea: false,
      }),
    ).toEqual(
      locales
        .filter((locale) => locale === baseLocale || locale === target)
        .map((locale) => ({
          locale,
          href: locale === baseLocale ? '/four-pillars' : encoded,
          current: locale === baseLocale,
        })),
    )
  })

  it('本页没有该语言版本时不列出（方案 A），不再指向该语言首页', () => {
    const alternates = new Map([[baseLocale, '/blog/only-default']])
    expect(
      languageOptions({
        locale: baseLocale,
        pathname: '/blog/only-default',
        alternates,
        appArea: false,
      }),
    ).toEqual([{ locale: baseLocale, href: '/blog/only-default', current: true }])
  })

  it('应用区列出全部语言并停留在当前地址；其他没有 hreflang 的页面同路径加前缀', () => {
    expect(
      languageOptions({ locale: baseLocale, pathname: '/app/x', alternates: null, appArea: true }),
    ).toEqual(locales.map((locale) => ({ locale, href: '/app/x', current: locale === baseLocale })))
    const login = languageOptions({
      locale: baseLocale,
      pathname: '/login',
      alternates: null,
      appArea: false,
    })
    expect(login.find((option) => option.locale === target)?.href).toBe(
      localizeHref('/login', { locale: target }),
    )
  })
})
