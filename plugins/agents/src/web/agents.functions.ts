import {
  type AvailableModel,
  dbModelStore,
  listAvailableModels,
  requireAvailableModel,
} from '@saas/ai'
import { getCreditBalance } from '@saas/credits'
import { aiAgentTurn, aiConversation, type Database, scoped } from '@saas/db'
import { getEntitlements } from '@saas/entitlements'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { conversationTitleSchema } from '@web/features/ai/conversation.ts'
import { readFaultAccess } from '@web/features/ai/fault-access.ts'
import type { PickerModel } from '@web/features/ai/model-picker.ts'
import { withBilling } from '@web/server/feature-gates.ts'
import { withWorkspace } from '@web/server/middleware.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { findAgentOption, listAgentOptions } from './catalog.ts'
import { agentsWebConfig } from './config.ts'
import { type AgentTurnView, toTurnView } from './turns.ts'

// agent 对话列表与对话页的数据（openspec add-ai-agents 任务 6.2、决策 1、6、7）。
// 与文本对话一致，对话只对创建者可见：所有读写在 scoped(ws) 之上再按 user_id 与 kind = 'agent' 过滤，
// 他人的对话与不存在的一样返回 404。消息正文只在 Durable Object 中，这里只读写 PG 的对话行与轮次摘要。

const workspace = z.object({ slug: z.string().min(1).max(64) })
const conversationInput = workspace.extend({ conversationId: z.uuid() })

/** 列表最多返回的对话数（与文本对话一致） */
const LIST_LIMIT = 100
/** 对话页带回的最近轮次数（回答下方的本轮摘要） */
const TURN_LIMIT = 50

/**
 * 自己的、未删除的 agent 对话。删除沿用文本对话的字段语义（`archived = true`，见 deleteAgentConversation）。
 * 接口假设（3.1 / 3.2 / 7.x）：前置处理与实例把 `archived = true` 的 agent 对话视同不存在（404 并自清理）。
 */
const ownAgentConversation = (userId: string, conversationId?: string) =>
  and(
    eq(aiConversation.userId, userId),
    eq(aiConversation.kind, 'agent'),
    eq(aiConversation.archived, false),
    conversationId === undefined ? undefined : eq(aiConversation.id, conversationId),
  ) as SQL

type MutationResult<T> = { ok: true; result: T } | { ok: false; error: string }

async function mutation<T>(
  readOnly: boolean,
  action: () => Promise<T>,
): Promise<MutationResult<T>> {
  try {
    if (readOnly)
      throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', {
        status: 403,
      })
    return { ok: true, result: await action() }
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500)
      log.error('agents.conversation.failed', { error })
    return { ok: false, error: error instanceof AppError ? error.code : 'CONVERSATION_FAILED' }
  }
}

interface RequestContext {
  db: Database
  workspace: { id: string }
  user: { id: string }
}

async function registryContext(db: Database) {
  const runtime = getWebRuntime()
  return {
    store: dbModelStore(db),
    cache: runtime.cache,
    workersAi: runtime.ai?.available === true && runtime.ai.value.workersAi.available,
    faultAccess: await readFaultAccess({
      auth: runtime.auth,
      db,
      headers: getRequest().headers,
      env: runtime.ai?.available ? runtime.ai.value.config : {},
    }),
  }
}

const entitlementsOf = (context: RequestContext) =>
  getEntitlements(context.db, context.workspace.id, {
    pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
  })

const pickerModel = (model: AvailableModel): PickerModel => ({
  id: model.id,
  key: model.key,
  pricing: model.pricing,
  // agent 的推理开关不在本次范围
  supportsThinking: false,
})

/** 空间权益允许、已启用且标记支持工具调用的文本模型（新建弹窗与对话页的模型选择） */
async function toolModels(context: RequestContext): Promise<PickerModel[]> {
  const models = await listAvailableModels(
    await registryContext(context.db),
    await entitlementsOf(context),
    { kind: 'text', requiresTools: true },
  )
  return models.map(pickerModel)
}

/** 校验模型可用于 agent：不存在、停用、不支持工具 → MODEL_UNAVAILABLE；权益不允许 → UPGRADE_REQUIRED */
async function requireToolModel(context: RequestContext, modelId: string) {
  return requireAvailableModel(
    await registryContext(context.db),
    await entitlementsOf(context),
    modelId,
    { kind: 'text', requiresTools: true },
  )
}

const turnFields = {
  id: aiAgentTurn.id,
  conversationId: aiAgentTurn.conversationId,
  status: aiAgentTurn.status,
  steps: aiAgentTurn.steps,
  creditsCharged: aiAgentTurn.creditsCharged,
  modelKey: aiAgentTurn.modelKey,
  errorCode: aiAgentTurn.errorCode,
  toolCalls: aiAgentTurn.toolCalls,
}

/** 各对话最近一轮（外层已按空间过滤；相关子查询按同一对话取 id 最大的一行，走唯一约束的前缀索引） */
async function latestTurns(context: RequestContext, conversationIds: readonly string[]) {
  if (conversationIds.length === 0) return new Map<string, AgentTurnView>()
  const rows = await scoped(context.db, context.workspace.id).select(aiAgentTurn, {
    fields: turnFields,
    where: and(
      eq(aiAgentTurn.userId, context.user.id),
      inArray(aiAgentTurn.conversationId, [...conversationIds]),
      sql`${aiAgentTurn.id} = (select latest.id from ${aiAgentTurn} as latest
        where latest.conversation_id = ${aiAgentTurn.conversationId}
        order by latest.id desc limit 1)`,
    ) as SQL,
  })
  return new Map(rows.map((row) => [row.conversationId, toTurnView(row)]))
}

/** 一个对话的最近轮次（时间正序）与当前可用余额 */
async function conversationTurns(context: RequestContext, conversationId: string) {
  const [rows, balance] = await Promise.all([
    scoped(context.db, context.workspace.id)
      .select(aiAgentTurn, {
        fields: turnFields,
        where: and(
          eq(aiAgentTurn.userId, context.user.id),
          eq(aiAgentTurn.conversationId, conversationId),
        ) as SQL,
      })
      .orderBy(desc(aiAgentTurn.id))
      .limit(TURN_LIMIT),
    getCreditBalance(context.db, context.workspace.id),
  ])
  return { turns: rows.reverse().map(toTurnView), balance: Math.floor(balance.available) }
}

async function ownConversation(context: RequestContext, conversationId: string) {
  const [conversation] = await scoped(context.db, context.workspace.id)
    .select(aiConversation, {
      fields: {
        id: aiConversation.id,
        title: aiConversation.title,
        agentId: aiConversation.agentId,
        modelKey: aiConversation.modelKey,
      },
      where: ownAgentConversation(context.user.id, conversationId),
    })
    .limit(1)
  return conversation
}

export const listAgentConversations = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace)
  .handler(async ({ context }) => {
    const [conversations, models] = await Promise.all([
      scoped(context.db, context.workspace.id)
        .select(aiConversation, {
          fields: {
            id: aiConversation.id,
            title: aiConversation.title,
            agentId: aiConversation.agentId,
            modelKey: aiConversation.modelKey,
            updatedAt: aiConversation.updatedAt,
          },
          where: ownAgentConversation(context.user.id),
        })
        .orderBy(desc(aiConversation.updatedAt), desc(aiConversation.id))
        .limit(LIST_LIMIT),
      toolModels(context),
    ])
    const turns = await latestTurns(
      context,
      conversations.map((item) => item.id),
    )
    return {
      conversations: conversations.map((item) => ({
        id: item.id,
        title: item.title,
        agentId: item.agentId ?? '',
        modelKey: item.modelKey,
        updatedAt: item.updatedAt.toISOString(),
        turn: turns.get(item.id) ?? null,
      })),
      agents: listAgentOptions(),
      models,
      readOnly: context.workspaceReadOnly,
    }
  })

export const getAgentConversation = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput)
  .handler(async ({ context, data }) => {
    const conversation = await ownConversation(context, data.conversationId)
    if (!conversation) throw notFound()
    const [models, { turns, balance }] = await Promise.all([
      toolModels(context),
      conversationTurns(context, conversation.id),
    ])
    const agentId = conversation.agentId ?? ''
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        modelKey: conversation.modelKey,
      },
      // 定义已从项目中移除的 agent 仍按 id 显示，名称回落到 id
      agent: findAgentOption(agentId) ?? {
        id: agentId,
        name: agentId,
        description: '',
        tools: [],
        suggestions: [],
      },
      models,
      turns,
      balance,
      maxSteps: agentsWebConfig.maxSteps,
      maxTurnCredits: agentsWebConfig.maxTurnCredits ?? null,
      readOnly: context.workspaceReadOnly,
    }
  })

/** 一轮结束后刷新回答下方的本轮摘要与余额；他人或不存在的对话返回 null */
export const getAgentTurns = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput)
  .handler(async ({ context, data }) => {
    if (!(await ownConversation(context, data.conversationId))) return null
    return conversationTurns(context, data.conversationId)
  })

/**
 * 新建 agent 对话（决策 1）：先写 PG 行（kind = 'agent'、agent_id、model_key），再由页面连接
 * `/agents/agent-conversation/<id>`。模型须为权益允许、已启用且支持工具调用的文本模型。
 */
export const createAgentConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(workspace.extend({ agentId: z.string().min(1).max(64), modelId: z.uuid() }))
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, async () => {
      if (!findAgentOption(data.agentId))
        throw new AppError('AGENT_NOT_FOUND', 'Agent is not available', { status: 404 })
      const model = await requireToolModel(context, data.modelId)
      const [row] = await scoped(context.db, context.workspace.id)
        .insert(aiConversation, {
          userId: context.user.id,
          title: '',
          modelKey: model.key,
          kind: 'agent',
          agentId: data.agentId,
        })
        .returning({ id: aiConversation.id })
      if (!row) throw new AppError('CONVERSATION_FAILED', 'Conversation was not created')
      return row
    }),
  )

async function updateOwn(
  context: RequestContext,
  conversationId: string,
  set: { title?: string; archived?: boolean; modelKey?: string },
) {
  const rows = await scoped(context.db, context.workspace.id)
    .update(aiConversation, set, ownAgentConversation(context.user.id, conversationId))
    .returning({ id: aiConversation.id })
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  return { id: conversationId }
}

/** 标题在首轮结束后由对话页按首条消息填入 */
export const renameAgentConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput.extend({ title: conversationTitleSchema }))
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, () =>
      updateOwn(context, data.conversationId, { title: data.title }),
    ),
  )

/**
 * 对话中切换模型（新建弹窗说明「模型可在对话中调整」）：写回 `ai_conversation.model_key`。
 * 接口假设（4.1）：每轮开始时按对话行的 model_key 取模型并执行 requireAvailableModel（requiresTools）。
 */
export const setAgentConversationModel = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput.extend({ modelId: z.uuid() }))
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, async () => {
      const model = await requireToolModel(context, data.modelId)
      await updateOwn(context, data.conversationId, { modelKey: model.key })
      return { modelKey: model.key }
    }),
  )

/**
 * 删除对话（决策 7）：按现有对话的删除语义处理 PG 行——文本对话没有硬删，用 `archived = true` 软删；
 * agent 对话没有「取消归档」入口，软删后列表、对话页与前置处理都视同不存在。轮次记录保留供审计与结算
 * （执行中的轮次仍由清理器按检查点结算）。
 */
export const deleteAgentConversation = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(conversationInput)
  .handler(({ context, data }) =>
    mutation(context.workspaceReadOnly, async () => {
      const result = await updateOwn(context, data.conversationId, { archived: true })
      // TODO(7.1)：经 web 的 Durable Object 绑定调用实例清理（deleteAll）；失败不回滚 PG，由实例 alarm 自清理兜底
      return result
    }),
  )
