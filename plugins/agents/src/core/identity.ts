// agent 对话的身份头（openspec add-ai-agents 决策 2、3.1 / 3.2）：前置处理剥离客户端带来的 x-saas-* 头，
// 校验会话与归属后写入下面三个头；实例只信任它们（Durable Object 只能经本 Worker 访问），
// 并与首次请求记住的归属逐请求比对。

export const IDENTITY_HEADER_PREFIX = 'x-saas-'

export const IDENTITY_HEADERS = {
  userId: 'x-saas-user-id',
  workspaceId: 'x-saas-workspace-id',
  conversationId: 'x-saas-conversation-id',
} as const

export interface AgentIdentity {
  readonly userId: string
  readonly workspaceId: string
  readonly conversationId: string
}

/** 实例首次处理请求时记住的归属 */
export interface AgentOwner {
  readonly userId: string
  readonly workspaceId: string
}

/** 复制请求头并删除全部 `x-saas-*`（大小写不敏感），防止客户端伪造身份 */
export function stripIdentityHeaders(headers: Headers): Headers {
  const copy = new Headers(headers)
  for (const name of [...copy.keys()])
    if (name.toLowerCase().startsWith(IDENTITY_HEADER_PREFIX)) copy.delete(name)
  return copy
}

/** 剥离客户端的 `x-saas-*` 后写入服务端确定的身份；方法、正文与升级头保持不变 */
export function withIdentity(request: Request, identity: AgentIdentity): Request {
  const headers = stripIdentityHeaders(request.headers)
  headers.set(IDENTITY_HEADERS.userId, identity.userId)
  headers.set(IDENTITY_HEADERS.workspaceId, identity.workspaceId)
  headers.set(IDENTITY_HEADERS.conversationId, identity.conversationId)
  return new Request(request, { headers })
}

export function readIdentity(headers: Headers): AgentIdentity | null {
  const userId = headers.get(IDENTITY_HEADERS.userId)
  const workspaceId = headers.get(IDENTITY_HEADERS.workspaceId)
  const conversationId = headers.get(IDENTITY_HEADERS.conversationId)
  return userId && workspaceId && conversationId ? { userId, workspaceId, conversationId } : null
}

export type OwnerCheck =
  | { readonly ok: true; readonly owner: AgentOwner; readonly first: boolean }
  | {
      readonly ok: false
      readonly reason: 'missing_identity' | 'conversation_mismatch' | 'owner_mismatch'
    }

/**
 * 实例侧比对（3.2）：身份头缺失、对话 id 与实例名不一致、或与已记住的归属不一致都拒绝；
 * 尚未记住归属时以本次身份为准（`first: true`，调用方负责持久化）。
 */
export function checkOwner(
  stored: AgentOwner | undefined,
  identity: AgentIdentity | null,
  instanceName: string,
): OwnerCheck {
  if (!identity) return { ok: false, reason: 'missing_identity' }
  if (identity.conversationId !== instanceName)
    return { ok: false, reason: 'conversation_mismatch' }
  if (!stored)
    return {
      ok: true,
      owner: { userId: identity.userId, workspaceId: identity.workspaceId },
      first: true,
    }
  if (stored.userId !== identity.userId || stored.workspaceId !== identity.workspaceId)
    return { ok: false, reason: 'owner_mismatch' }
  return { ok: true, owner: stored, first: false }
}

/** 实例名只能是 PG 中对话的小写 UUID（决策 1、11）；其他名字一律视为不存在 */
export function isConversationId(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
}
