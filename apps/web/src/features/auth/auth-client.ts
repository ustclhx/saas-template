import { createAuthClient } from 'better-auth/client'
import {
  emailOTPClient,
  inferAdditionalFields,
  magicLinkClient,
  organizationClient,
  twoFactorClient,
} from 'better-auth/client/plugins'
import { forgetSignedIn } from '../i18n/home-locale.ts'

/**
 * 浏览器端的 Better Auth 客户端（接口挂在同源的 /api/auth/*）。
 * 关闭默认的 redirect 插件：登录接口的 `callbackURL` 同时用作验证邮件中的回跳地址（/verify-email），
 * 登录成功后由页面自己跳转到 /app，而不是跳到 callbackURL。
 */
function create() {
  return createAuthClient({
    basePath: '/api/auth',
    disableDefaultFetchPlugins: true,
    plugins: [
      organizationClient(),
      emailOTPClient(),
      magicLinkClient(),
      twoFactorClient(),
      inferAdditionalFields({
        user: {
          locale: { type: 'string', required: false },
          timezone: { type: 'string', required: false },
        },
      }),
    ],
  })
}

let client: ReturnType<typeof create> | undefined

/** 只在浏览器事件处理中调用（SSR 时不创建客户端） */
export function authClient() {
  client ??= create()
  return client
}

const RENEWED_KEY = 'saas:session-renewed'
/** 续期检查间隔：Better Auth 的 updateAge 为 1 天，半天检查一次即可保证活跃用户每天续上 */
const RENEW_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * 应用读会话走 requireFreshSession（直接查库、不写回），不会触发 Better Auth 的滚动续期。
 * 已登录页面挂载时按间隔调用一次 get-session（跳过 Cookie 缓存），由 Better Auth 在到达 updateAge 时
 * 延长数据库、KV 与浏览器 Cookie 的有效期。失败只是本次不续期，不影响页面。
 */
export function renewSession(now = Date.now()): void {
  let last = 0
  try {
    last = Number(window.localStorage.getItem(RENEWED_KEY)) || 0
  } catch {
    // 存储不可用时每次挂载都检查；get-session 未到 updateAge 时不写库
  }
  if (now - last < RENEW_INTERVAL_MS) return
  void authClient()
    .getSession({ query: { disableCookieCache: true } })
    .then(({ data }) => {
      if (!data) return
      try {
        window.localStorage.setItem(RENEWED_KEY, String(now))
      } catch {
        // 同上
      }
    })
    .catch(() => {})
}

/** 登录成功后的去处；/app 再重定向到当前空间（docs/04-auth-and-tenancy.md §3） */
export const AFTER_SIGN_IN_PATH = '/app'

/** Only these local destinations may be resumed after authentication. */
export function signInDestination(search: string): string {
  const redirect = new URLSearchParams(search).get('redirect')
  return redirect &&
    (redirect === '/account' ||
      /^\/accept-invitation\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        redirect,
      ))
    ? redirect
    : AFTER_SIGN_IN_PATH
}

export function signInCallbackURL() {
  return signInDestination(window.location.search)
}

/** 整页跳转：让服务端以新的会话 Cookie 渲染应用区 */
export function goToApp() {
  window.location.assign(signInCallbackURL())
}

/**
 * 退出登录：先清除客户端登录信号与首页语言标记（multilingual-seo 4.4，home-locale.ts），再调用 Better Auth。
 * 所有退出入口都应经过这里，公开页才不会在退出后继续按旧登录状态跳转。
 */
export function signOut() {
  forgetSignedIn()
  try {
    window.localStorage.removeItem(RENEWED_KEY)
  } catch {
    // 存储不可用
  }
  return authClient().signOut()
}
