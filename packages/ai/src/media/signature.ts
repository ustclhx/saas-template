const encoder = new TextEncoder()
const key = (secret: string) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(`ai-media:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

/**
 * 签名覆盖任务 ID 与尝试序号（add-media-provider-fallback D4）。序号 0 沿用旧格式（只签任务 ID、地址不带序号），
 * 切换前发出的地址与首个尝试完全一致，无需迁移；序号 ≥1 的地址带 `attempt` 参数并签 `<taskId>:a<n>`。
 */
const signedMessage = (taskId: string, attempt: number) =>
  attempt === 0 ? taskId : `${taskId}:a${attempt}`

export async function mediaCallbackUrl(
  origin: string,
  secret: string,
  task: { id: string; provider: string; attempt?: number },
): Promise<string> {
  const attempt = task.attempt ?? 0
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    encoder.encode(signedMessage(task.id, attempt)),
  )
  const url = new URL(`/api/webhooks/media/${encodeURIComponent(task.provider)}`, origin)
  url.searchParams.set('task', task.id)
  if (attempt > 0) url.searchParams.set('attempt', String(attempt))
  url.searchParams.set(
    'sig',
    Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  )
  return url.toString()
}

/** 回调地址中的尝试序号：缺省为 0（含旧格式地址），只接受 1–99 的十进制整数，其余为 null。 */
export function parseMediaCallbackAttempt(value: string | null): number | null {
  if (value === null) return 0
  return /^[1-9]\d?$/.test(value) ? Number(value) : null
}

export async function verifyMediaCallbackSignature(
  secret: string,
  taskId: string,
  signature: string,
  attempt = 0,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
  return crypto.subtle.verify(
    'HMAC',
    await key(secret),
    bytes,
    encoder.encode(signedMessage(taskId, attempt)),
  )
}
