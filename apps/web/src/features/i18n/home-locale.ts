// 已登录用户首页记住语言（ML-09，openspec multilingual-seo 决策 6、任务 4.4）与客户端登录信号。
// 只用 localStorage：公开页不查库、不读会话，爬虫与匿名访客没有这些记录，天然不跳转。
// 所有读写都包在 try/catch 里：隐私模式或禁用存储时读写失败，结果只是「不跳转」「不记住」。

/** 客户端登录信号：已登录的应用区页面挂载时写入（带过期时间），退出登录时清除 */
export const SIGNED_IN_KEY = 'saas:signed-in'
/** 首页记住语言的标记：已登录用户在语言切换器中手动选择的语言 */
export const HOME_LOCALE_KEY = 'saas:home-locale'
/**
 * 登录信号的有效期：固定 7 天，不长于默认会话保持期（auth.sessionDays，默认 30）；每次进入应用区刷新。
 * 会话在服务端被吊销或过期而本机没有退出时，信号最迟在此之后失效；期间最多误跳到所选语言首页，不涉及数据。
 */
export const SIGNED_IN_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function read(key: string, store = storage()): string | null {
  try {
    return store?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string | null, store = storage()): void {
  try {
    if (value === null) store?.removeItem(key)
    else store?.setItem(key, value)
  } catch {
    // 存储不可用：本次不记住
  }
}

/** 已登录的页面（工作台、账号、后台）挂载时调用 */
export function markSignedIn(now = Date.now(), store = storage()): void {
  write(SIGNED_IN_KEY, String(now + SIGNED_IN_TTL_MS), store)
}

/** 客户端是否认为处于登录状态：信号存在且未过期 */
export function signedInHint(now = Date.now(), store = storage()): boolean {
  const expires = Number(read(SIGNED_IN_KEY, store))
  return Number.isFinite(expires) && expires > now
}

/** 退出登录（或注销账号）时调用：清除登录信号与首页语言标记 */
export function forgetSignedIn(store = storage()): void {
  write(SIGNED_IN_KEY, null, store)
  write(HOME_LOCALE_KEY, null, store)
}

/** 已登录用户手动选择语言时调用；未登录时不写 */
export function rememberHomeLocale(locale: string, now = Date.now(), store = storage()): void {
  if (signedInHint(now, store)) write(HOME_LOCALE_KEY, locale, store)
}

export function readHomeLocale(store = storage()): string | null {
  return read(HOME_LOCALE_KEY, store)
}

/**
 * 首页是否应带到所选语言首页，返回目标地址或 null。全部条件都满足才跳：
 * 功能开启、当前是默认语言首页 `/`、客户端认为已登录、标记是已配置语言且不同于当前语言、
 * 本页 hreflang 中有该语言（所选语言没有已发布首页时不跳）。内页与分享链接永远不跳。
 */
export function homeLocaleTarget({
  enabled,
  pathname,
  locale,
  baseLocale,
  locales,
  marker,
  signedIn,
  alternates,
}: {
  enabled: boolean
  pathname: string
  locale: string
  baseLocale: string
  locales: readonly string[]
  marker: string | null
  signedIn: boolean
  alternates: ReadonlyMap<string, string> | null
}): string | null {
  if (!enabled || pathname !== '/' || locale !== baseLocale || !signedIn) return null
  if (!marker || marker === locale || !locales.includes(marker)) return null
  return alternates?.get(marker) ?? null
}
