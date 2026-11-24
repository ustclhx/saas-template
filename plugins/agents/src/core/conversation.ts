import { aiConversation, type Database, member, organization, scoped } from '@saas/db'
import { and, eq, isNull, type SQL } from 'drizzle-orm'

// agent 对话的归属查询（openspec add-ai-agents 决策 2、3）：前置处理与实例每轮开始前共用。
// 只认创建者本人、仍是空间成员、空间未软删、未归档的 agent 对话；其余情况一律当作不存在（404）。
// 已归档（用户删除对话的现有语义）与 PG 中不存在等同：实例据此自清理。

export interface AgentConversationRow {
  readonly id: string
  readonly workspaceId: string
  readonly userId: string
  readonly agentId: string
  readonly modelKey: string
  readonly isPersonal: boolean
  readonly updatedAt: Date
}

const fields = {
  id: aiConversation.id,
  workspaceId: aiConversation.workspaceId,
  userId: aiConversation.userId,
  agentId: aiConversation.agentId,
  modelKey: aiConversation.modelKey,
  updatedAt: aiConversation.updatedAt,
  isPersonal: organization.isPersonal,
}

function toRow(row: {
  id: string
  workspaceId: string
  userId: string
  agentId: string | null
  modelKey: string
  isPersonal: boolean
  updatedAt: Date
}): AgentConversationRow | null {
  return row.agentId === null ? null : { ...row, agentId: row.agentId }
}

/**
 * 前置处理（3.1）：只有对话 id 与会话用户。对话 id 是主键，空间由对话行确定，
 * 同一查询再按 member 表确认该用户仍是该空间成员，跨空间访问拿不到行。
 */
export async function findOwnedAgentConversation(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<AgentConversationRow | null> {
  const [row] = await db
    .select(fields)
    .from(aiConversation)
    .innerJoin(
      organization,
      and(eq(organization.id, aiConversation.workspaceId), isNull(organization.deletedAt)),
    )
    .innerJoin(
      member,
      and(eq(member.organizationId, aiConversation.workspaceId), eq(member.userId, input.userId)),
    )
    .where(
      and(
        eq(aiConversation.id, input.conversationId),
        eq(aiConversation.userId, input.userId),
        eq(aiConversation.kind, 'agent'),
        eq(aiConversation.archived, false),
      ) as SQL,
    )
    .limit(1)
  return row ? toRow(row) : null
}

export type ConversationAccess =
  | { readonly kind: 'ok'; readonly conversation: AgentConversationRow }
  /** PG 中已没有这个对话或已归档（已删除）：实例应拒绝并自清理 */
  | { readonly kind: 'gone' }
  /** 对话仍在，但用户已不是成员、空间已删除或归属不符：拒绝，不清理 */
  | { readonly kind: 'denied' }

/** 实例每轮开始前重新校验（决策 3 第一步）：空间来自实例记住的归属，查询经 `scoped` */
export async function checkConversationAccess(
  db: Database,
  input: { workspaceId: string; userId: string; conversationId: string },
): Promise<ConversationAccess> {
  const s = scoped(db, input.workspaceId)
  const [row] = await s
    .select(aiConversation, {
      where: and(
        eq(aiConversation.id, input.conversationId),
        eq(aiConversation.kind, 'agent'),
      ) as SQL,
      fields: { userId: aiConversation.userId, archived: aiConversation.archived },
    })
    .limit(1)
  if (!row || row.archived) return { kind: 'gone' }
  if (row.userId !== input.userId) return { kind: 'denied' }
  const conversation = await findOwnedAgentConversation(db, input)
  return conversation && conversation.workspaceId === input.workspaceId
    ? { kind: 'ok', conversation }
    : { kind: 'denied' }
}
