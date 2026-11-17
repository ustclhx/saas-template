import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseLocale, locales, overwriteGetLocale } from '../../paraglide/runtime.js'

const route = vi.hoisted(() => ({ pathname: '/' }))
vi.mock('@tanstack/react-router', () => ({ useLocation: () => route }))
vi.mock('./preference.functions.ts', () => ({ saveLanguagePreference: vi.fn() }))

import { LanguageControls } from './language-controls.tsx'

const candidates = locales.filter((locale) => locale !== baseLocale)
const banners = (html: string) =>
  html.match(/<aside\b[^>]*data-locale-suggestion-for="[^"]+"[^>]*>/g) ?? []

afterEach(() => {
  route.pathname = '/'
  overwriteGetLocale(() => baseLocale)
})

describe('语言建议横幅（首帧即在最终位置）', () => {
  it.skipIf(candidates.length === 0)(
    '默认语言营销页服务端输出每个候选语言的隐藏横幅与显示规则，由首帧前脚本选择显示哪一条',
    () => {
      for (const pathname of ['/', '/pricing']) {
        route.pathname = pathname
        const html = renderToString(<LanguageControls />)
        expect(banners(html)).toHaveLength(candidates.length)
        for (const banner of banners(html)) expect(banner).toMatch(/class="hidden /)
        expect(html).toContain(`[data-locale-suggestion-for="${candidates[0]}"]{display:flex}`)
      }
    },
  )

  it('非营销页、非默认语言页与关闭建议的实例不输出横幅', () => {
    route.pathname = '/login'
    expect(banners(renderToString(<LanguageControls />))).toHaveLength(0)
    route.pathname = '/'
    expect(banners(renderToString(<LanguageControls suggest={false} />))).toHaveLength(0)
    const other = candidates[0]
    if (other) {
      overwriteGetLocale(() => other)
      route.pathname = `/${other}`
      expect(banners(renderToString(<LanguageControls />))).toHaveLength(0)
    }
  })
})
