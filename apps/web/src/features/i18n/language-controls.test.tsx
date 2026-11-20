// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, type Locale, locales, overwriteGetLocale } from '../../paraglide/runtime.js'

const route = vi.hoisted(() => ({ pathname: '/pricing', links: [] as unknown[] }))
vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: route.pathname }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: route.pathname }, matches: [{ links: route.links }] }),
}))
const api = vi.hoisted(() => ({ saveLanguagePreference: vi.fn() }))
vi.mock('./preference.functions.ts', () => api)
const config = vi.hoisted(() => ({ rememberHomeLocale: false }))
vi.mock('../../server/template-config.ts', async (original) => {
  const actual = await original<typeof import('../../server/template-config.ts')>()
  return {
    templateConfig: {
      ...actual.templateConfig,
      i18n: {
        ...actual.templateConfig.i18n,
        get rememberHomeLocale() {
          return config.rememberHomeLocale
        },
      },
    },
  }
})

import { HOME_LOCALE_KEY, markSignedIn } from './home-locale.ts'
import { LanguageAssist, PROMPT_DISMISSED_KEY, promptTarget } from './language-assist.tsx'
import { LanguageControls } from './language-controls.tsx'

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

// Node 内置的 localStorage（未指定存储文件时为 undefined）会遮蔽 happy-dom 的实现：测试换成内存版
class MemoryStorage {
  #data = new Map<string, string>()
  getItem(key: string) {
    return this.#data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.#data.set(key, String(value))
  }
  removeItem(key: string) {
    this.#data.delete(key)
  }
  clear() {
    this.#data.clear()
  }
}
const memory = new MemoryStorage()
vi.stubGlobal('localStorage', memory)

const other = locales.find((locale) => locale !== baseLocale) as Locale | undefined
const prefix = other ? `/${other.toLowerCase()}` : ''
const hreflang = (paths: Record<string, string>) => [
  ...Object.entries(paths).map(([hrefLang, path]) => ({
    rel: 'alternate',
    hrefLang,
    href: `https://app.example${path}`,
  })),
  { rel: 'alternate', hrefLang: 'x-default', href: 'https://app.example/pricing' },
]

function browser(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
}

beforeEach(() => {
  route.pathname = '/pricing'
  route.links = hreflang({
    [baseLocale]: '/pricing',
    ...(other && { [other]: `${prefix}/pricing` }),
  })
  config.rememberHomeLocale = false
  api.saveLanguagePreference.mockReset()
  api.saveLanguagePreference.mockResolvedValue({ ok: true })
  localStorage.clear()
  overwriteGetLocale(() => baseLocale)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)))

describe.runIf(other !== undefined)('语言提示条（multilingual-seo 4.2）', () => {
  const target = other as Locale

  it('服务端输出中没有提示（也没有首帧脚本或 data-locale-suggestion 属性）', () => {
    browser([target])
    expect(renderToString(<LanguageAssist />)).toBe('')
  })

  it('浏览器首选语言有已发布版本时，水合后出现指向该版本的普通链接，文案用目标语言', async () => {
    browser([`${target}-CN`, 'en'])
    render(<LanguageAssist />)
    expect(document.querySelector('[data-language-prompt]')).toBeNull()
    // 提示条组件按需懒加载：首次加载模块较慢
    const link = await screen.findByRole('link', {}, { timeout: 5_000 })
    const prompt = document.querySelector('[data-language-prompt]') as HTMLElement
    expect(prompt.getAttribute('lang')).toBe(target)
    expect(link.getAttribute('href')).toBe(`${prefix}/pricing`)
    expect(link.getAttribute('hreflang')).toBe(target)
    expect(link.textContent).toBe(m.i18n_prompt_action({}, { locale: target }))
    expect(prompt.getAttribute('aria-label')).toBe(m.i18n_prompt_region({}, { locale: target }))
  })

  it('对应语言未发布、首选即当前语言或没有匹配时不提示', async () => {
    route.links = hreflang({ [baseLocale]: '/blog/only-default' })
    browser([target])
    render(<LanguageAssist />)
    await settle()
    expect(document.querySelector('[data-language-prompt]')).toBeNull()
    expect(
      promptTarget({
        locale: baseLocale,
        languages: [baseLocale, target],
        locales,
        alternates: new Map([[target, '/x']]),
      }),
    ).toBeNull()
    expect(
      promptTarget({ locale: baseLocale, languages: ['xx'], locales, alternates: new Map() }),
    ).toBeNull()
    expect(
      promptTarget({ locale: baseLocale, languages: [target], locales, alternates: null }),
    ).toBeNull()
  })

  it('关闭后写入 localStorage，本浏览器不再提示；存储不可用时不抛错', async () => {
    browser([target])
    const { unmount } = render(<LanguageAssist />)
    await settle()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.animationEnd(document.querySelector('[data-language-prompt]') as HTMLElement)
    await settle()
    expect(document.querySelector('[data-language-prompt]')).toBeNull()
    expect(localStorage.getItem(PROMPT_DISMISSED_KEY)).toBe('1')
    unmount()
    render(<LanguageAssist />)
    await settle()
    expect(document.querySelector('[data-language-prompt]')).toBeNull()

    localStorage.clear()
    vi.spyOn(memory, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    cleanup()
    render(<LanguageAssist />)
    await settle()
    expect(document.querySelector('[data-language-prompt]')).not.toBeNull()
  })
})

describe.runIf(other !== undefined)('首页记住语言（ML-09）', () => {
  const target = other as Locale
  let replace: ReturnType<typeof vi.fn>
  beforeEach(() => {
    route.pathname = '/'
    route.links = hreflang({ [baseLocale]: '/', [target]: prefix })
    replace = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      replace,
    } as unknown as Location)
    browser([baseLocale])
  })

  it('开启、已登录且标记有效时跳到所选语言首页，不再显示提示', async () => {
    config.rememberHomeLocale = true
    markSignedIn()
    localStorage.setItem(HOME_LOCALE_KEY, target)
    render(<LanguageAssist />)
    await settle()
    expect(replace).toHaveBeenCalledWith(prefix)
    expect(document.querySelector('[data-language-prompt]')).toBeNull()
  })

  it('功能关闭、匿名或内页时不跳', async () => {
    localStorage.setItem(HOME_LOCALE_KEY, target)
    markSignedIn()
    render(<LanguageAssist />)
    await settle()
    cleanup()
    config.rememberHomeLocale = true
    localStorage.removeItem('saas:signed-in')
    render(<LanguageAssist />)
    await settle()
    cleanup()
    markSignedIn()
    route.pathname = '/pricing'
    render(<LanguageAssist />)
    await settle()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe.runIf(other !== undefined)('语言切换器（multilingual-seo 4.3）', () => {
  const target = other as Locale

  async function open() {
    render(<LanguageControls placement="bare" />)
    const trigger = screen.getByRole('button', { name: 'Language' })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findByRole('menu')
    return screen.getAllByRole('menuitem')
  }

  it('服务端输出触发器与当前语言，水合前禁用；菜单项不进入服务端 HTML', () => {
    const html = renderToString(<LanguageControls />)
    expect(html).toContain('English')
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).not.toContain(`${prefix}/pricing`)
    expect(html).not.toContain('data-locale-suggestion')
  })

  it('只列本页真实存在的语言版本，每项是普通链接', async () => {
    let items = await open()
    expect(items.map((item) => item.getAttribute('href'))).toEqual(
      locales
        .filter((locale) => locale === baseLocale || locale === target)
        .map((locale) => (locale === baseLocale ? '/pricing' : `${prefix}/pricing`)),
    )
    cleanup()
    route.links = hreflang({ [baseLocale]: '/blog/only-default' })
    route.pathname = '/blog/only-default'
    items = await open()
    expect(items.map((item) => item.getAttribute('hreflang'))).toEqual([baseLocale])
  })

  it('匿名访客：写 Cookie 后由链接跳转，不请求服务端、不写首页标记', async () => {
    const items = await open()
    const link = items.find((item) => item.getAttribute('hreflang') === target) as HTMLElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(api.saveLanguagePreference).not.toHaveBeenCalled()
    expect(document.cookie).toContain(`=${target}`)
    expect(localStorage.getItem(HOME_LOCALE_KEY)).toBeNull()
  })

  it('已登录：保存到账号设置并写首页标记，再跳到该语言版本', async () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location)
    markSignedIn()
    const items = await open()
    const link = items.find((item) => item.getAttribute('hreflang') === target) as HTMLElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await settle()
    expect(api.saveLanguagePreference).toHaveBeenCalledWith({ data: target })
    expect(localStorage.getItem(HOME_LOCALE_KEY)).toBe(target)
    expect(assign).toHaveBeenCalledWith(`${prefix}/pricing`)
  })

  it('应用区列出全部语言，选择后保存并停留在当前地址', async () => {
    route.pathname = '/app/personal'
    route.links = []
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: 'http://localhost/app/personal?tab=x',
      assign,
    } as unknown as Location)
    const items = await open()
    expect(items).toHaveLength(locales.length)
    fireEvent.click(items.find((item) => item.getAttribute('hreflang') === target) as HTMLElement)
    await settle()
    expect(api.saveLanguagePreference).toHaveBeenCalledWith({ data: target })
    expect(assign).toHaveBeenCalledWith('http://localhost/app/personal?tab=x')
  })
})
