import { describe, expect, it } from 'vitest'
import { baseLocale, locales, localizeHref } from '../../paraglide/runtime.js'
import { documentAlternates, localeSwitchHref } from './alternates.ts'

// 用最小的 querySelectorAll 替身代替 DOM：只需要 hreflang 与 href 两个属性
const head = (links: Record<string, string>) =>
  ({
    querySelectorAll: () =>
      Object.entries(links).map(([hreflang, href]) => ({
        getAttribute: (name: string) => (name === 'hreflang' ? hreflang : href),
      })),
  }) as unknown as ParentNode

const other = locales.find((locale) => locale !== baseLocale)

describe.runIf(other !== undefined)('语言切换目标地址（multilingual-seo 3.2）', () => {
  const target = other ?? baseLocale
  const encoded = `/${target}/${encodeURIComponent('四柱')}`

  it('读取本页 hreflang（不含 x-default），只取 pathname', () => {
    expect(
      documentAlternates(
        head({
          [baseLocale]: 'https://app.example/four-pillars',
          [target]: `https://app.example${encoded}`,
          'x-default': 'https://app.example/four-pillars',
        }),
      ),
    ).toEqual(
      new Map([
        [baseLocale, '/four-pillars'],
        [target, encoded],
      ]),
    )
    expect(documentAlternates(head({}))).toBeNull()
  })

  it('本地化 slug：跳到声明的地址，在当前 origin 上保留查询参数与锚点', () => {
    const alternates = new Map([
      [baseLocale, '/four-pillars'],
      [target, encoded],
    ])
    expect(
      localeSwitchHref('http://localhost:3000/four-pillars?ref=x#top', target, alternates),
    ).toBe(`http://localhost:3000${encoded}?ref=x#top`)
  })

  it("本页没有该语言版本：'hide' 跳到该语言首页，'fallback' 沿用同路径加前缀", () => {
    const alternates = new Map([[baseLocale, '/blog/only-default']])
    const current = 'http://localhost:3000/blog/only-default'
    expect(localeSwitchHref(current, target, alternates, 'hide')).toBe(
      new URL(localizeHref('/', { locale: target }), current).href,
    )
    expect(localeSwitchHref(current, target, alternates, 'fallback')).toBe(
      new URL(localizeHref('/blog/only-default', { locale: target }), current).href,
    )
  })

  it('页面没有 hreflang（应用区、404）时同路径加前缀', () => {
    const current = 'http://localhost:3000/pricing'
    expect(localeSwitchHref(current, target, null, 'hide')).toBe(
      new URL(localizeHref('/pricing', { locale: target }), current).href,
    )
  })
})
