import {
  CHAT_HOLD_TTL_MS,
  type CheckpointScheduleOptions,
  checkpointSchedule,
  dbModelStore,
  defaultLanguageModelFactory,
  estimateInputTokens,
  estimateTextTokens,
  type LanguageModelFactory,
  MODEL_UNAVAILABLE,
  messageText,
  type Pricing,
  planTextBudget,
  requireAvailableModel,
  settleChatMessage,
  settleFromCheckpoint,
  settleInterruptedChatMessage,
  type TextModelEnv,
  textModelConfig,
  truncateHistory,
  writeUsageCheckpoint,
} from '@saas/ai'
import { type RateLimiter, requireFreshSession } from '@saas/auth'
import type { OveragePolicy } from '@saas/credits'
import { CreditsError, getCreditBalance, hold } from '@saas/credits'
import {
  type AiMessage,
  type AiPricingJson,
  aiConversation,
  aiMessage,
  type Database,
  scoped,
} from '@saas/db'
import { type Entitlements, getEntitlements } from '@saas/entitlements'
import { AppError, newId, toErrorResponse } from '@saas/shared'
import { log, setLogContext } from '@saas/shared/log'
import { convertToModelMessages, type LanguageModelUsage, streamText, type UIMessage } from 'ai'
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import { resolveWorkspaceBySlug } from '../../server/workspace-context.ts'

/**
 * `POST /api/ai/chat`（docs/06-ai.md §3「流程」，specs/ai-chat）：
 * 会话 → 空间 → 权益（模型可用）→ `RL_AI` 限流 → 欠费 / 余额检查 → 定价快照 + 预扣 + 插入 streaming 消息
 * （同一事务）→ `streamText` → `waitUntil(consumeStream())` → `onEnd` 中按实际用量结算。
 * 响应使用 AI SDK 的 UI message 流协议，前端用 `useChat`（请求体见 `chatRequestSchema`）。
 *
 * 服务端以数据库中的历史为准，客户端只提交本轮的用户消息；对话只对创建者可见（scoped(ws) + user_id）。
 * 读流过程中写用量检查点；停止见 `handleChatStopRequest`，进程中断时由 apps/jobs 的兜底处理器结算。
 */

export interface ChatDeps {
  readonly db: Database
  readonly auth: Parameters<typeof requireFreshSession>[0]['auth']
  /** 构造模型所需的环境变量，原样交给工厂 */
  readonly env: TextModelEnv
  /** `RL_AI` 绑定 */
  readonly rateLimiter: RateLimiter
  /** 请求上下文的 `waitUntil`：客户端断开后继续读完模型流并结算 */
  readonly waitUntil: (promise: Promise<unknown>) => void
  /** 默认 `defaultLanguageModelFactory`；测试注入模拟模型 */
  readonly languageModelFactory?: LanguageModelFactory
  /** 默认按订阅读取（`getEntitlements`） */
  readonly entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
  /** 默认取模板配置 `billing.overage` */
  readonly overage?: OveragePolicy
  /** 用量检查点节奏，默认每 5 秒或每 200 个输出 token；测试可调 */
  readonly checkpoint?: CheckpointScheduleOptions
}

const textPart = z.object({ type: z.literal('text'), text: z.string().min(1).max(100_000) })

export const chatRequestSchema = z.object({
  /** 当前空间（URL 中的 `$slug`） */
  slug: z.string().min(1).max(64),
  modelId: z.uuid(),
  /** 省略时新建对话 */
  conversationId: z.uuid().optional(),
  /** 本轮的用户消息；首版只接受文本 */
  message: z.object({
    role: z.literal('user'),
    parts: z.array(textPart).min(1).max(16),
  }),
})

export type ChatRequest = z.infer<typeof chatRequestSchema>

/** 发给客户端的消息元数据（UI message 流的 start 事件） */
export interface ChatMessageMetadata {
  readonly conversationId: string
  readonly messageId: string
}

const CONVERSATION_TITLE_LENGTH = 80

/**
 * 本 isolate 中进行中的回复：停止请求落在同一 isolate 时直接中止上游生成，并等待按内存中的完整
 * 已生成内容结算。Workers 不保证停止请求与原请求在同一 isolate，见 `handleChatStopRequest`。
 */
interface ActiveChat {
  abort(): void
  /** 读流与结算完成 */
  readonly done: Promise<void>
}
const activeChats = new Map<string, ActiveChat>()

export async function handleChatRequest(request: Request, deps: ChatDeps): Promise<Response> {
  try {
    return await startChat(request, deps)
  } catch (error) {
    if (!(error instanceof AppError)) log.error('ai.chat.failed', { error })
    const { status, body } = toErrorResponse(toAppError(error))
    return Response.json(body, { status })
  }
}

function toAppError(error: unknown): unknown {
  if (!(error instanceof CreditsError)) return error
  switch (error.code) {
    case 'CREDIT_DEBT':
      return new AppError('CREDIT_DEBT', 'Workspace has unpaid credit debt', { status: 402 })
    case 'INSUFFICIENT_CREDITS':
      return new AppError('INSUFFICIENT_CREDITS', 'Insufficient credits', { status: 402 })
    default:
      return error
  }
}

async function readRequest(request: Request): Promise<ChatRequest> {
  const body = await request.json().catch(() => undefined)
  const parsed = chatRequestSchema.safeParse(body)
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid chat request')
  return parsed.data
}

async function startChat(request: Request, deps: ChatDeps): Promise<Response> {
  const { db } = deps
  const { user } = await requireFreshSession({ auth: deps.auth, db, headers: request.headers })
  const input = await readRequest(request)
  const resolved = await resolveWorkspaceBySlug(db, user.id, input.slug)
  if (!resolved) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  const workspaceId = resolved.workspace.id
  setLogContext({ workspaceId, userId: user.id })
  if (!templateConfig.tenancy.multiTenant && !resolved.workspace.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  const s = scoped(db, workspaceId)

  // 1. 权益：模型已启用且当前套餐允许；取定价快照
  const entitlements = await (
    deps.entitlements ??
    ((db, workspaceId) =>
      getEntitlements(db, workspaceId, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      }))
  )(db, workspaceId)
  const model = await requireAvailableModel(
    { store: dbModelStore(db) },
    entitlements,
    input.modelId,
  )
  if (model.kind !== 'text')
    throw new AppError(MODEL_UNAVAILABLE, 'Model is not available', { status: 404 })
  const pricing = model.pricing

  // 2. 限流（按数据中心计数，只用于防刷）
  if (!(await deps.rateLimiter.limit({ key: `ai:${workspaceId}:${user.id}` })).success)
    throw new AppError('RATE_LIMITED', 'Too many requests, please try again later', { status: 429 })

  const languageModel = (deps.languageModelFactory ?? defaultLanguageModelFactory)(model, deps.env)

  // 3. 对话与历史：只读创建者自己的对话
  let conversationId = input.conversationId
  let history: { role: 'user' | 'assistant'; text: string }[] = []
  if (conversationId !== undefined) {
    const [conversation] = await s
      .select(aiConversation, {
        where: and(
          eq(aiConversation.id, conversationId),
          eq(aiConversation.userId, user.id),
        ) as SQL,
      })
      .limit(1)
    if (!conversation) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    const rows = await s
      .select(aiMessage, {
        where: and(
          eq(aiMessage.conversationId, conversationId),
          inArray(aiMessage.role, ['user', 'assistant']),
          inArray(aiMessage.status, ['completed', 'aborted']),
        ) as SQL,
      })
      .orderBy(asc(aiMessage.id))
    history = rows.flatMap((row) => {
      const text = messageText(row.parts)
      return text && (row.role === 'user' || row.role === 'assistant')
        ? [{ role: row.role, text }]
        : []
    })
  }
  const userText = input.message.parts.map((part) => part.text).join('')
  const { tokensPerChar, maxOutputTokens: modelMaxOutput } = textModelConfig(model)
  let prompt = [...history, { role: 'user' as const, text: userText }]
  if (pricing.mode === 'per_call' && pricing.limits?.maxInputTokens !== undefined) {
    prompt = truncateHistory(prompt, pricing.limits.maxInputTokens, tokensPerChar)
  }
  const inputTokens = estimateInputTokens(prompt, tokensPerChar)

  // 4. 欠费 / 余额：按余额确定最大输出与预扣额（hold 在锁内再次检查）
  const balance = await getCreditBalance(db, workspaceId)
  if (balance.debt > 0)
    throw new AppError('CREDIT_DEBT', 'Workspace has unpaid credit debt', { status: 402 })
  const budget = planTextBudget({
    pricing,
    inputTokens,
    balance: balance.available,
    maxOutputTokens: modelMaxOutput,
  })

  // 5. 同一事务：对话、用户消息、预扣、带定价快照的 streaming 消息
  const assistantId = newId()
  const holdId = await db.transaction(async (tx) => {
    const t = scoped(tx, workspaceId)
    if (conversationId === undefined) {
      conversationId = newId()
      await t.insert(aiConversation, {
        id: conversationId,
        userId: user.id,
        title: userText.slice(0, CONVERSATION_TITLE_LENGTH),
        modelKey: model.key,
      })
    }
    await t.insert(aiMessage, {
      conversationId,
      role: 'user',
      parts: input.message.parts,
    })
    const reservation = await hold(tx, {
      workspaceId,
      userId: user.id,
      amount: budget.holdAmount,
      refType: 'ai_message',
      refId: assistantId,
      expiresAt: new Date(Date.now() + CHAT_HOLD_TTL_MS),
    })
    await t.insert(aiMessage, {
      id: assistantId,
      conversationId,
      role: 'assistant',
      parts: [],
      modelKey: model.key,
      pricing: pricing as AiPricingJson,
      status: 'streaming',
      // 结算前存放输入估算：兜底处理器在没有检查点时据此收最低费用（design 决策 4）
      inputTokens,
      holdId: reservation.id,
    })
    return reservation.id
  })
  const metadata: ChatMessageMetadata = {
    conversationId: conversationId as string,
    messageId: assistantId,
  }

  // 6. 流式调用；结算与客户端连接解耦
  const uiMessages: Omit<UIMessage, 'id'>[] = prompt.map((message) => ({
    role: message.role,
    parts: [{ type: 'text', text: message.text }],
  }))
  const overage = deps.overage ?? templateConfig.billing.overage
  const controller = new AbortController()
  const schedule = checkpointSchedule(deps.checkpoint)
  let text = ''
  let end:
    | { text: string; usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> }
    | undefined
  let checkpoints: Promise<unknown> = Promise.resolve()
  const outputTokensOf = (value: string) => estimateTextTokens(value, tokensPerChar)
  const result = streamText({
    model: languageModel,
    messages: await convertToModelMessages(uiMessages),
    maxOutputTokens: budget.maxOutputTokens,
    abortSignal: controller.signal,
    // 用量检查点（tasks 2.5）：不阻塞读流，写入串行；写入失败只记日志。
    // 消息已被停止接口或兜底处理器结束（其他 isolate）时中止上游生成
    onChunk: ({ chunk }) => {
      if (chunk.type !== 'text-delta') return
      text += chunk.text
      const outputTokens = outputTokensOf(text)
      if (!schedule.due(outputTokens)) return
      const snapshot = text
      checkpoints = checkpoints.then(async () => {
        try {
          const streaming = await writeUsageCheckpoint(db, {
            workspaceId,
            messageId: assistantId,
            inputTokens,
            outputTokens,
            text: snapshot,
          })
          if (!streaming) controller.abort('settled')
        } catch (error) {
          log.error('ai.chat.checkpoint_failed', { messageId: assistantId, error })
        }
      })
    },
    onEnd: (event) => {
      end = { text: event.text, usage: event.totalUsage }
    },
    onError: ({ error }) => {
      log.error('ai.chat.stream_error', { messageId: assistantId, error })
    },
  })

  // 读完模型流后结算：完成 → 按实际用量；停止 → aborted、出错 → failed，均按已产生用量。
  // 结算失败时预扣保持 held，由超时兜底处理器结算；已被另一方结算时不重复结算
  const done = (async () => {
    // 中止与服务商错误已由 onError / 中止原因处理，这里只读完流
    await result.consumeStream({ onError: () => {} })
    await checkpoints
    try {
      if (end) {
        await settleChatMessage(db, {
          workspaceId,
          messageId: assistantId,
          holdId,
          pricing,
          text: end.text,
          inputTokens: end.usage.inputTokens ?? inputTokens,
          outputTokens: end.usage.outputTokens ?? outputTokensOf(end.text),
          overage,
        })
      } else {
        await settleInterruptedChatMessage(db, {
          workspaceId,
          messageId: assistantId,
          holdId,
          pricing,
          overage,
          status: controller.signal.aborted ? 'aborted' : 'failed',
          text,
          inputTokens,
          outputTokens: outputTokensOf(text),
          hasOutput: text !== '',
        })
      }
    } catch (error) {
      log.error('ai.chat.settle_failed', { messageId: assistantId, error })
    } finally {
      activeChats.delete(assistantId)
    }
  })()
  activeChats.set(assistantId, { abort: () => controller.abort('stop'), done })
  deps.waitUntil(done)

  return result.toUIMessageStreamResponse({
    generateMessageId: () => assistantId,
    messageMetadata: ({ part }) => (part.type === 'start' ? metadata : undefined),
    headers: { 'x-conversation-id': metadata.conversationId },
  })
}

export interface ChatStopDeps {
  readonly db: Database
  readonly auth: Parameters<typeof requireFreshSession>[0]['auth']
  /** 默认取模板配置 `billing.overage` */
  readonly overage?: OveragePolicy
  /** 默认本 isolate 的进行中回复；测试传入空表模拟停止请求落在其他 isolate */
  readonly activeChats?: ReadonlyMap<string, ActiveChat>
}

const stopRequestSchema = z.object({ slug: z.string().min(1).max(64) })

/** 停止接口的响应：消息当前（结束后）的状态 */
export interface ChatStopResponse {
  readonly status: 'aborted' | 'completed' | 'failed'
}

/**
 * `POST /api/ai/chat/:messageId/stop`（design 决策 6，specs/ai-chat「主动停止」）：请求体 `{ slug }`，
 * 只能停止自己对话中的回复；他人消息或不存在返回 404，已结束的消息幂等返回当前状态。
 *
 * - 原请求在本 isolate：中止上游生成，按已生成内容（按 token 以文本估算输出用量）结算并标记 aborted。
 * - 原请求在其他 isolate（拿不到 AbortController）：按已持久化的最后一个检查点结算并标记 aborted；
 *   原请求在下次写检查点时发现消息已结束即中止生成，结束时的结算因预扣已结算而跳过，不重复结算。
 */
export async function handleChatStopRequest(
  request: Request,
  messageId: string,
  deps: ChatStopDeps,
): Promise<Response> {
  try {
    return Response.json(await stopChat(request, messageId, deps))
  } catch (error) {
    if (!(error instanceof AppError)) log.error('ai.chat.stop_failed', { error })
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}

async function stopChat(
  request: Request,
  messageId: string,
  deps: ChatStopDeps,
): Promise<ChatStopResponse> {
  const { db } = deps
  const { user } = await requireFreshSession({ auth: deps.auth, db, headers: request.headers })
  const parsed = stopRequestSchema.safeParse(await request.json().catch(() => undefined))
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid stop request')
  const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })
  const resolved = await resolveWorkspaceBySlug(db, user.id, parsed.data.slug)
  if (!resolved || !z.uuid().safeParse(messageId).success) throw notFound()
  setLogContext({ workspaceId: resolved.workspace.id, userId: user.id })
  const s = scoped(db, resolved.workspace.id)

  // 只认创建者自己对话中的回复
  const load = async () => {
    const [row] = await s
      .select(aiMessage, {
        where: and(
          eq(aiMessage.id, messageId),
          eq(aiMessage.role, 'assistant'),
          inArray(
            aiMessage.conversationId,
            s.select(aiConversation, {
              where: eq(aiConversation.userId, user.id),
              fields: { id: aiConversation.id },
            }),
          ),
        ) as SQL,
      })
      .limit(1)
    if (!row) throw notFound()
    return row
  }
  const ended = (status: AiMessage['status']) =>
    status === 'streaming' ? null : { status: status as ChatStopResponse['status'] }

  let message = await load()
  const local = (deps.activeChats ?? activeChats).get(messageId)
  if (message.status === 'streaming' && local) {
    local.abort()
    await local.done
    message = await load()
  }
  // 已结束（含本 isolate 刚结算完）；本地结算失败时仍为 streaming，继续按检查点结算
  const result = ended(message.status)
  if (result) return result
  if (!message.holdId || !message.pricing) throw notFound()
  const settled = await settleFromCheckpoint(
    db,
    { ...message, holdId: message.holdId, pricing: message.pricing as Pricing },
    { status: 'aborted', overage: deps.overage ?? templateConfig.billing.overage },
  )
  if (settled) return { status: 'aborted' }
  // 并发的另一方（原请求或兜底处理器）先结算
  return ended((await load()).status) ?? { status: 'aborted' }
}
