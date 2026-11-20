import { describe, expect, it } from 'vitest'
import {
  forgetSignedIn,
  HOME_LOCALE_KEY,
  homeLocaleTarget,
  markSignedIn,
  readHomeLocale,
  rememberHomeLocale,
  SIGNED_IN_KEY,
  SIGNED_IN_TTL_MS,
  signedInHint,
} from './home-locale.ts'

function memory() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const broken = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
  removeItem: () => {
    throw new Error('denied')
  },
}

const base = {
  enabled: true,
  pathname: '/',
  locale: 'en',
  baseLocale: 'en',
  locales: ['en', 'zh'],
  marker: 'zh',
  signedIn: true,
  alternates: new Map([
    ['en', '/'],
    ['zh', '/zh'],
  ]),
}

describe('首页记住语言（ML-09）', () => {
  it('全部条件满足时带到所选语言首页（取本页 hreflang 的地址）', () => {
    expect(homeLocaleTarget(base)).toBe('/zh')
  })

  it('功能关闭时不跳', () => {
    expect(homeLocaleTarget({ ...base, enabled: false })).toBeNull()
  })

  it('匿名访客（没有登录信号）不跳', () => {
    expect(homeLocaleTarget({ ...base, signedIn: false })).toBeNull()
  })

  it('标记缺失、无效、未配置或与当前语言相同时不跳', () => {
    for (const marker of [null, '', 'fr', 'ZH', 'en', '<script>'])
      expect(homeLocaleTarget({ ...base, marker }), String(marker)).toBeNull()
  })

  it('内页、其他语言首页与分享链接不跳', () => {
    for (const pathname of ['/pricing', '/blog/a', '/zh', '/s/card/abc', '/?ref=x'])
      expect(homeLocaleTarget({ ...base, pathname }), pathname).toBeNull()
    expect(homeLocaleTarget({ ...base, locale: 'zh' })).toBeNull()
  })

  it('所选语言没有已发布首页（hreflang 中没有）时不跳', () => {
    expect(homeLocaleTarget({ ...base, alternates: new Map([['en', '/']]) })).toBeNull()
    expect(homeLocaleTarget({ ...base, alternates: null })).toBeNull()
  })
})

describe('客户端登录信号与标记', () => {
  it('登录信号带过期时间；只有已登录时才写标记；退出登录一并清除', () => {
    const store = memory()
    rememberHomeLocale('zh', 1000, store)
    expect(readHomeLocale(store)).toBeNull()
    markSignedIn(1000, store)
    expect(signedInHint(1000, store)).toBe(true)
    expect(signedInHint(1000 + SIGNED_IN_TTL_MS + 1, store)).toBe(false)
    rememberHomeLocale('zh', 2000, store)
    expect(store.data.get(HOME_LOCALE_KEY)).toBe('zh')
    forgetSignedIn(store)
    expect(store.data.has(SIGNED_IN_KEY)).toBe(false)
    expect(store.data.has(HOME_LOCALE_KEY)).toBe(false)
  })

  it('无效的登录信号视为未登录；存储不可用时读写不抛错', () => {
    const store = memory()
    store.data.set(SIGNED_IN_KEY, 'yes')
    expect(signedInHint(0, store)).toBe(false)
    expect(signedInHint(0, broken)).toBe(false)
    expect(readHomeLocale(broken)).toBeNull()
    expect(() => markSignedIn(0, broken)).not.toThrow()
    expect(() => forgetSignedIn(broken)).not.toThrow()
  })
})
