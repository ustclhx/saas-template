import type { KeyValueStore } from '@saas/platform'

/**
 * 待确认记录中密钥参数的加密（add-admin-step-up 决策 7，D5）。
 * 每条记录随机生成 AES-GCM 数据密钥：密文存库（admin_pending_action.secret_ciphertext），
 * 数据密钥只存在平台缓存，TTL 等于剩余有效期。缓存键到期或被删除后密文即不可解，
 * 「过期立即不可恢复」不依赖定时任务。密文以记录 ID 作为附加认证数据，不能挪到其他记录上使用。
 */

const KEY_PREFIX = 'admin-confirmation:key:'
/** Cloudflare KV 的 expirationTtl 最小 60 秒 */
const MIN_TTL_SECONDS = 60
const IV_BYTES = 12

export function confirmationKeyName(id: string) {
  return `${KEY_PREFIX}${id}`
}

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

/** 加密密钥参数并把数据密钥写入缓存；返回 `iv || 密文`。 */
export async function sealConfirmationSecret(
  cache: KeyValueStore,
  id: string,
  secret: unknown,
  expiresAt: Date,
  now = new Date(),
): Promise<Uint8Array> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintext = new TextEncoder().encode(JSON.stringify(secret))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
      key,
      plaintext,
    ),
  )
  const ttl = Math.max(MIN_TTL_SECONDS, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000))
  await cache.put(confirmationKeyName(id), toBase64(raw), { expirationTtl: ttl })
  const sealed = new Uint8Array(IV_BYTES + ciphertext.length)
  sealed.set(iv)
  sealed.set(ciphertext, IV_BYTES)
  return sealed
}

/** 解密；数据密钥已不在缓存（到期、终态已删除）或密文被篡改时返回 undefined。 */
export async function openConfirmationSecret(
  cache: KeyValueStore,
  id: string,
  sealed: Uint8Array,
): Promise<{ readonly value: unknown } | undefined> {
  const stored = await cache.get(confirmationKeyName(id))
  if (!stored || sealed.length <= IV_BYTES) return undefined
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(stored), 'AES-GCM', false, [
      'decrypt',
    ])
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.slice(0, IV_BYTES),
        additionalData: new TextEncoder().encode(id),
      },
      key,
      sealed.slice(IV_BYTES),
    )
    return { value: JSON.parse(new TextDecoder().decode(plaintext)) as unknown }
  } catch {
    return undefined
  }
}

/** 终态提交后删除数据密钥；失败只影响「提前」不可解，缓存 TTL 仍会让它到期失效。 */
export async function dropConfirmationSecret(cache: KeyValueStore, id: string) {
  try {
    await cache.delete(confirmationKeyName(id))
  } catch {
    // TTL 兜底
  }
}
