// 令牌页的纯函数：有效期选项、状态与 Claude Code 命令。客户端与服务端共用，不含服务端依赖。

const DAY_MS = 86_400_000

/** 令牌名称上限：tokens.ts 的创建校验与页面表单共用 */
export const TOKEN_NAME_MAX = 100
export const TOKEN_TERMS = [30, 90, 180, 365] as const
/** 剩余天数不超过该值时提示即将过期 */
export const EXPIRY_WARNING_DAYS = 15

/** 可选有效期受插件 maxTokenDays 限制；上限小于 30 天时只提供上限本身 */
export function tokenTerms(maxTokenDays: number): number[] {
  const terms = TOKEN_TERMS.filter((days) => days <= maxTokenDays)
  return terms.length > 0 ? terms : [maxTokenDays]
}

/** 默认 90 天；不可选时取最长的可选项 */
export function defaultTerm(terms: readonly number[]): number {
  return terms.includes(90) ? 90 : (terms.at(-1) ?? 90)
}

export interface TokenRow {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly scopes: readonly string[]
  readonly expiresAt: Date
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
  readonly createdAt: Date
}

export type TokenState =
  | { kind: 'active'; daysLeft: number; expiring: boolean }
  | { kind: 'revoked'; at: Date }
  | { kind: 'expired' }

export function tokenState(token: TokenRow, now: Date): TokenState {
  if (token.revokedAt) return { kind: 'revoked', at: token.revokedAt }
  const left = token.expiresAt.getTime() - now.getTime()
  if (left <= 0) return { kind: 'expired' }
  const daysLeft = Math.ceil(left / DAY_MS)
  return { kind: 'active', daysLeft, expiring: daysLeft <= EXPIRY_WARNING_DAYS }
}

/** 使用中的令牌在前，已吊销与已过期的置灰排在后面；组内保持服务端的创建时间倒序 */
export function sortTokens<T extends TokenRow>(tokens: readonly T[], now: Date): T[] {
  const rank = (token: T) => (tokenState(token, now).kind === 'active' ? 0 : 1)
  return [...tokens].sort((a, b) => rank(a) - rank(b))
}

/** 固定按 UTC 显示日期，服务端与浏览器一致 */
export const formatDate = (value: Date) => value.toISOString().slice(0, 10)

export function expiryDate(days: number, now: Date) {
  return formatDate(new Date(now.getTime() + days * DAY_MS))
}

/** 以服务端返回的 now 计算的相对时间，单位取分钟 / 小时 / 天 */
export function relativeTime(value: Date, now: Date, locale: string) {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((value.getTime() - now.getTime()) / 60_000)
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return format.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return format.format(days, 'day')
  return formatDate(value)
}

/** MCP 服务名取应用名的小写短横线形式，如 MyApp → myapp-admin */
export function mcpServerName(appName: string) {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'saas'}-admin`
}

export function claudeCommand(serverName: string, endpoint: string, token: string) {
  return `claude mcp add --transport http ${serverName} ${endpoint} --header "Authorization: Bearer ${token}"`
}

/** 展示用：令牌只保留前缀，复制时使用完整值 */
export function maskToken(token: string) {
  return `${token.slice(0, 12)}…`
}
