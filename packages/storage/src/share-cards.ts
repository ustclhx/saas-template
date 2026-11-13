import type { KeyValueStore } from '@saas/platform'
import { AppError } from '@saas/shared'

/** 分享卡片仅需要按前缀分页与删除，不向业务层暴露目标 SDK。 */
export interface ShareCardObjects {
  list(input: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: readonly string[]
    cursor?: string
  }>
  delete(key: string): Promise<void>
}
export interface ShareCardIdentity {
  readonly type: string
  readonly token: string
  readonly workspaceId: string
}
export const SHARE_CARD_REVOCATION_TTL = 86_400
const segment = (value: string) => {
  // 类型可声明自己的令牌格式；这里只保护对象路径边界，不强制默认 base64url 字符集。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 对象键的信任边界需要拒绝控制字符。
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value))
    throw new AppError('INVALID_SHARE_CARD_KEY', 'Invalid share card key')
  return value
}
export const shareCardImagePrefix = (type: string, token: string) =>
  `share-cards/img/${segment(type)}/${segment(token)}/`
export const shareCardWorkspacePrefix = (workspaceId: string) =>
  `share-cards/ws/${segment(workspaceId)}/`
export const shareCardWorkspaceKey = ({ type, token, workspaceId }: ShareCardIdentity) =>
  `${shareCardWorkspacePrefix(workspaceId)}${segment(type)}/${segment(token)}`
export const shareCardRevokedKey = (type: string, token: string) =>
  `share-revoked:${segment(type)}:${segment(token)}`

export function createShareCardInvalidator(
  objects: ShareCardObjects,
  kv: Pick<KeyValueStore, 'put'>,
) {
  async function invalidateShareCard(input: ShareCardIdentity) {
    const prefix = shareCardImagePrefix(input.type, input.token)
    const index = shareCardWorkspaceKey(input)
    // 先阻止缓存读取；删除失败时保留索引，让空间清理可以重试。
    await kv.put(shareCardRevokedKey(input.type, input.token), '1', {
      expirationTtl: SHARE_CARD_REVOCATION_TTL,
    })
    let cursor: string | undefined
    do {
      const page = await objects.list({ prefix, ...(cursor ? { cursor } : {}) })
      for (const key of page.keys) await objects.delete(key)
      cursor = page.cursor
    } while (cursor)
    await objects.delete(index)
  }
  async function cleanupWorkspaceShareCards(workspaceId: string) {
    const prefix = shareCardWorkspacePrefix(workspaceId)
    let cursor: string | undefined
    let invalidated = 0
    do {
      const page = await objects.list({ prefix, ...(cursor ? { cursor } : {}) })
      for (const key of page.keys) {
        const [type, token, extra] = key.slice(prefix.length).split('/')
        if (!key.startsWith(prefix) || !type || !token || extra !== undefined)
          throw new AppError('INVALID_SHARE_CARD_KEY', 'Invalid share card workspace index')
        await invalidateShareCard({ type, token, workspaceId })
        invalidated++
      }
      cursor = page.cursor
    } while (cursor)
    return { invalidated }
  }
  return { invalidateShareCard, cleanupWorkspaceShareCards }
}
