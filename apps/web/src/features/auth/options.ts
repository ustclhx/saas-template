import type { OAuthProvider, TemplateConfig } from '@saas/config'

/** 认证页面需要的公开配置：启用了哪些登录方式、Turnstile site key。不含任何密钥。 */
export interface AuthUiOptions {
  readonly emailPassword: boolean
  readonly emailOtp: boolean
  readonly magicLink: boolean
  /** 已启用且配置了凭据的 OAuth 提供方（与 @saas/auth 注册 socialProviders 的条件一致） */
  readonly oauth: readonly OAuthProvider[]
  /** `auth.turnstile=false` 时为 `null`，页面不渲染小组件、请求不带令牌 */
  readonly turnstileSiteKey: string | null
}

/** 上次成功登录使用的方式（Better Auth lastLoginMethod 插件写入的 Cookie 值，只含方式名） */
export type LastLoginMethod = 'email' | 'email-otp' | 'magic-link' | OAuthProvider

/** Better Auth lastLoginMethod 插件的默认 Cookie 名；不带 __Secure- 前缀 */
export const LAST_LOGIN_METHOD_COOKIE = 'better-auth.last_used_login_method'

/** 只接受已知方式名；Cookie 可被用户改写，未知值按无记录处理 */
export function parseLastLoginMethod(cookieHeader: string | null): LastLoginMethod | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== LAST_LOGIN_METHOD_COOKIE) continue
    // 允许的方式名都不需要解码；不解码也避免畸形 % 序列抛错让登录页失败
    const value = rest.join('=')
    return ['email', 'email-otp', 'magic-link', 'google', 'github'].includes(value)
      ? (value as LastLoginMethod)
      : null
  }
  return null
}

export interface AuthUiEnv {
  readonly TURNSTILE_SITE_KEY?: string | undefined
  readonly GOOGLE_CLIENT_ID?: string | undefined
  readonly GOOGLE_CLIENT_SECRET?: string | undefined
  readonly GITHUB_CLIENT_ID?: string | undefined
  readonly GITHUB_CLIENT_SECRET?: string | undefined
}

const OAUTH_CREDENTIALS = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
} as const satisfies Record<OAuthProvider, readonly (keyof AuthUiEnv)[]>

/**
 * 按模板配置决定登录页显示哪些入口（specs/user-auth「可配置的登录方式」：未开启的方式在界面上隐藏）。
 */
export function authUiOptions(config: TemplateConfig, env: AuthUiEnv): AuthUiOptions {
  const { auth } = config
  return {
    emailPassword: auth.emailPassword,
    emailOtp: auth.emailOtp,
    magicLink: auth.magicLink,
    oauth: auth.oauth.filter((provider) =>
      OAUTH_CREDENTIALS[provider].every((key) => Boolean(env[key])),
    ),
    turnstileSiteKey: auth.turnstile ? (env.TURNSTILE_SITE_KEY ?? null) : null,
  }
}
