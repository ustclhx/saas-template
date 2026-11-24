import { type AuthContextSource, requireFreshSession } from '@saas/auth'
import type { Database } from '@saas/db'
import { AppError, toErrorResponse } from '@saas/shared'
import { log } from '@saas/shared/log'
import { findOwnedAgentConversation } from '../core/conversation.ts'
import { isConversationId, withIdentity } from '../core/identity.ts'

// `/agents/*` 的身份校验（openspec add-ai-agents 决策 2，任务 3.1），与 Agents SDK 无关：
// 由 routeAgentRequest 的 onBeforeConnect（WebSocket）与 onBeforeRequest（HTTP，含 SDK 自带的
// get-messages）共用。顺序：剥离 x-saas-* → 站点会话（401）→ 对话归属与成员资格（404）→ 写入身份头。

export interface AgentGateDeps {
  readonly db: Database
  readonly auth: AuthContextSource
}

const notFound = () =>
  Response.json(toErrorResponse(new AppError('NOT_FOUND', 'Not found', { status: 404 })).body, {
    status: 404,
  })

/**
 * 通过时返回带服务端身份头的新请求（客户端的 x-saas-* 已全部丢弃），否则返回错误响应；
 * 实例在任何拒绝分支都不会被访问。
 */
export async function authorizeAgentRequest(
  request: Request,
  conversationId: string,
  deps: AgentGateDeps,
): Promise<Request | Response> {
  if (!isConversationId(conversationId)) return notFound()
  let userId: string
  try {
    // 与文本对话相同：按数据库校验会话与封禁状态，吊销后的会话不能继续连接
    const { user } = await requireFreshSession({
      auth: deps.auth,
      db: deps.db,
      headers: request.headers,
    })
    userId = user.id
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500)
      log.error('agents.gate.session_failed', { error })
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
  const conversation = await findOwnedAgentConversation(deps.db, { conversationId, userId })
  if (!conversation) {
    log.info('agents.gate.not_found', { conversationId, userId })
    return notFound()
  }
  return withIdentity(request, {
    userId,
    workspaceId: conversation.workspaceId,
    conversationId,
  })
}
