import type { Database } from '@saas/db'
import type { ShareCardTheme } from '@saas/ui/share-card-theme'
import type { JSX } from 'react'

export type { ShareCardTheme } from '@saas/ui/share-card-theme'

export interface ShareCardContext {
  readonly db: Database
}

export interface ShareResolution<T> {
  readonly workspaceId: string
  readonly sharedAt: Date
  /** 省略时按类型有效天数计算；null 表示永不过期。 */
  readonly expiresAt?: Date | null
  readonly data: T
}

export interface ShareCardDefinition<T> {
  readonly type: string
  readonly version: number
  readonly tokenPattern?: RegExp
  readonly ttlDays?: number | null
  readonly sharePage?: false
  resolve(token: string, ctx: ShareCardContext): Promise<ShareResolution<T> | null>
  digest(data: T): string
  render(data: T, theme: ShareCardTheme): JSX.Element
  alt(data: T): string
  /** 通用分享页与元数据使用；label 是分享页标题上方的类型标签，可省略。 */
  page(data: T): { title: string; description: string; label?: string }
}

export type RegisteredShareCard<T> = Omit<
  ShareCardDefinition<T>,
  'tokenPattern' | 'ttlDays' | 'sharePage'
> & {
  readonly tokenPattern: RegExp
  readonly ttlDays: number | null
  readonly sharePage: boolean
}
