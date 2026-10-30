import { FIRST_TOUCH_COOKIE, parseFirstTouch, readCookie } from '@saas/shared/analytics'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../paraglide/runtime.js', () => ({ getLocale: () => 'zh' }))

import { templateConfig } from '../../server/template-config.ts'
import { ensureFirstTouch, startClarity, trackEvent } from './track.ts'

type Queued = ((...args: unknown[]) => void) & { q?: unknown[][] }
let browser: { location: URL; plausible?: Queued }
let nav: { userAgent: string; doNotTrack: string | null }
let scripts: { id?: string; src?: string }[]
let cookie: string

const go = (path: string) => {
  browser.location = new URL(path, 'https://acme.example')
}
const queue = () => browser.plausible?.q ?? []

beforeEach(() => {
  cookie = ''
  scripts = []
  browser = { location: new URL('https://acme.example/guides/x?utm_source=chatgpt&token=secret') }
  nav = { userAgent: 'Mozilla/5.0 (Macintosh)', doNotTrack: null }
  vi.stubGlobal('window', browser)
  vi.stubGlobal('navigator', nav)
  vi.stubGlobal('document', {
    referrer: '',
    get cookie() {
      return cookie
    },
    set cookie(value: string) {
      cookie = value.split(';')[0] ?? ''
    },
    getElementById: (id: string) => scripts.find((script) => script.id === id) ?? null,
    createElement: () => ({}),
    head: { appendChild: (script: { id?: string; src?: string }) => scripts.push(script) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('trackEvent', () => {
  it('首触只写一次，并随事件带上统一属性与脱敏 URL', () => {
    ensureFirstTouch()
    go('/pricing?utm_source=other')
    ensureFirstTouch()
    const touch = parseFirstTouch(readCookie(cookie, FIRST_TOUCH_COOKIE))
    expect(touch).toMatchObject({ source: 'chatgpt', landingPath: '/guides/x' })

    go('/reset-password?token=secret')
    trackEvent('page_view')
    trackEvent('checkout_start', { plan: 'pro' })
    expect(queue()).toEqual([
      [
        'pageview',
        {
          u: 'https://acme.example/reset-password',
          props: {
            source: 'chatgpt',
            landing_path: '/guides/x',
            locale: 'zh',
            plan: '(none)',
            device: 'desktop',
          },
        },
      ],
      [
        'checkout_start',
        {
          u: 'https://acme.example/reset-password',
          props: expect.objectContaining({ plan: 'pro' }),
        },
      ],
    ])
    expect(JSON.stringify(queue())).not.toContain('secret')
  })

  it('脚本加载前事件先进队列且限长，加载后直接交给脚本', () => {
    for (let i = 0; i < 150; i += 1) trackEvent('page_view')
    expect(queue().length).toBe(100)
    const loaded = vi.fn()
    browser.plausible = loaded as Queued
    trackEvent('paywall_view')
    expect(loaded).toHaveBeenCalledWith('paywall_view', expect.anything())
  })

  it('后台路径或 DNT 时不上报也不写 Cookie', () => {
    go('/admin/users')
    trackEvent('page_view')
    ensureFirstTouch()
    expect(queue()).toEqual([])
    expect(cookie).toBe('')

    go('/')
    nav.doNotTrack = '1'
    trackEvent('page_view')
    ensureFirstTouch()
    expect(queue()).toEqual([])
    expect(cookie).toBe('')
  })

  it('模板关闭分析时不上报也不写 Cookie', () => {
    const { features } = templateConfig
    Object.assign(templateConfig, { features: { ...features, analytics: false } })
    try {
      trackEvent('page_view')
      ensureFirstTouch()
      expect(queue()).toEqual([])
      expect(cookie).toBe('')
    } finally {
      Object.assign(templateConfig, { features })
    }
  })
})

describe('startClarity', () => {
  it('默认关闭：未配置项目 ID 时任何页面都不加载', () => {
    startClarity('/')
    expect(scripts).toEqual([])
  })

  it('配置后只在公开页加载一次，应用区与 DNT 不加载', () => {
    const { analytics } = templateConfig
    Object.assign(templateConfig, { analytics: { ...analytics, clarityProjectId: 'abc123' } })
    try {
      startClarity('/app/personal/chat')
      expect(scripts).toEqual([])
      nav.doNotTrack = '1'
      startClarity('/')
      expect(scripts).toEqual([])
      nav.doNotTrack = null
      startClarity('/')
      startClarity('/pricing')
      expect(scripts.map((script) => script.src)).toEqual(['https://www.clarity.ms/tag/abc123'])
    } finally {
      Object.assign(templateConfig, { analytics })
    }
  })
})
