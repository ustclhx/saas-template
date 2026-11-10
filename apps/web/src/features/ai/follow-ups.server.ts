import {
  actualCredits,
  dbModelStore,
  defaultLanguageModelFactory,
  estimateCredits,
  estimateInputTokens,
  type LanguageModelFactory,
  listAvailableModels,
  messageText,
  type TextModelEnv,
  textModelConfig,
} from '@saas/ai'
import type { TemplateConfig } from '@saas/config'
import { CreditsError, capture, hold, type OveragePolicy, release } from '@saas/credits'
import { aiConversation, aiMessage, type Database, scoped } from '@saas/db'
import { type Entitlements, getEntitlements } from '@saas/entitlements'
import type { KeyValueStore, RateLimiter } from '@saas/platform'
import { AppError, newId } from '@saas/shared'
import { log } from '@saas/shared/log'
import { generateText } from 'ai'
import { and, asc, desc, eq, inArray, lt, type SQL } from 'drizzle-orm'
import { templateConfig } from '../../server/template-config.ts'

/**
 * 回复后的后续推荐问题（add-subject-chat design 决策 5，specs/ai-chat「回复后的后续问题」）。
 *
 * - 配置关闭时直接返回空列表，不查模型、不扣积分；
 * - 每条回复只生成一次：结果缓存在 KV（1 天），重复请求复用；
 * - 开启计费时先预扣再按实际用量结算，失败释放；预扣的 ref 指向一个不存在的消息 ID，
 *   进程中断时由现有 chatHoldSweeper 释放，不会多扣；
 * - 推荐问题不写入 ai_message，点击后才作为普通用户消息发送。
 */

export type FollowUpsConfig = TemplateConfig['ai']['text']['followUps']

export interface FollowUpsDeps {
  readonly db: Database
  readonly cache: KeyValueStore
  readonly env: TextModelEnv
  readonly workersAi: boolean
  readonly rateLimiter?: RateLimiter | undefined
  readonly languageModelFactory?: LanguageModelFactory
  readonly entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
  readonly config?: FollowUpsConfig
  readonly overage?: OveragePolicy
}

const CACHE_PREFIX = 'chat-follow-ups:'
const CACHE_TTL_SECONDS = 86_400
const MAX_OUTPUT_TOKENS = 256
const HOLD_TTL_MS = 2 * 60_000
/** 参与生成的上下文与本轮问答的字符上限，控制附加请求的成本 */
const MAX_CONTEXT_CHARS = 8_000
const MAX_TURN_CHARS = 4_000
const MAX_QUESTION_LENGTH = 200

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })

export async function generateFollowUps(
  deps: FollowUpsDeps,
  scope: { workspaceId: string; userId: string },
  messageId: string,
): Promise<{ questions: string[] }> {
  const config = deps.config ?? templateConfig.ai.text.followUps
  if (!config.enabled) return { questions: [] }
  const s = scoped(deps.db, scope.workspaceId)

  // 只认自己对话中已完成的助手回复
  const [message] = await s
    .select(aiMessage, {
      where: and(eq(aiMessage.id, messageId), eq(aiMessage.role, 'assistant')) as SQL,
    })
    .limit(1)
  if (!message) throw notFound()
  const [conversation] = await s
    .select(aiConversation, {
      fields: { id: aiConversation.id },
      where: and(
        eq(aiConversation.id, message.conversationId),
        eq(aiConversation.userId, scope.userId),
      ) as SQL,
    })
    .limit(1)
  if (!conversation) throw notFound()
  if (message.status !== 'completed') return { questions: [] }

  const cacheKey = `${CACHE_PREFIX}${message.id}`
  const cached = await deps.cache.get(cacheKey)
  if (cached !== null) return { questions: parseQuestions(cached, config.count) }

  if (
    deps.rateLimiter &&
    !(await deps.rateLimiter.limit('ai', `ai:${scope.workspaceId}:${scope.userId}`)).success
  )
    throw new AppError('RATE_LIMITED', 'Too many requests, please try again later', { status: 429 })

  const entitlements = await (
    deps.entitlements ??
    ((db, workspaceId) =>
      getEntitlements(db, workspaceId, {
        pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
      }))
  )(deps.db, scope.workspaceId)
  const models = await listAvailableModels(
    { store: dbModelStore(deps.db), cache: deps.cache, workersAi: deps.workersAi },
    entitlements,
    { kind: 'text' },
  )
  const model = models.find((m) => m.key === (config.modelKey ?? message.modelKey))
  if (!model) return { questions: [] }

  const prompt = await followUpPrompt(deps.db, scope.workspaceId, message, config.count)
  const { tokensPerChar } = textModelConfig(model)
  const inputTokens = estimateInputTokens(
    prompt.map((m) => ({ text: m.content })),
    tokensPerChar,
  )

  let holdId: string | undefined
  if (config.charge) {
    try {
      const reservation = await hold(deps.db, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        amount: estimateCredits(model.pricing, { inputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS }),
        refType: 'ai_message',
        refId: newId(),
        expiresAt: new Date(Date.now() + HOLD_TTL_MS),
      })
      holdId = reservation.id
    } catch (error) {
      // 余额不足或欠费时不生成推荐问题，也不打断主对话
      if (error instanceof CreditsError) return { questions: [] }
      throw error
    }
  }

  try {
    const languageModel = (deps.languageModelFactory ?? defaultLanguageModelFactory)(
      model,
      deps.env,
    )
    const result = await generateText({
      model: languageModel,
      // 与聊天流一致：对象上下文以首条 system 消息传入
      allowSystemInMessages: true,
      messages: prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    })
    const questions = parseQuestions(result.text, config.count)
    if (holdId)
      await capture(deps.db, {
        workspaceId: scope.workspaceId,
        holdId,
        actualAmount: actualCredits(model.pricing, {
          inputTokens: result.usage.inputTokens ?? inputTokens,
          outputTokens: result.usage.outputTokens ?? 0,
        }),
        overage: deps.overage ?? templateConfig.billing.overage,
      })
    await deps.cache.put(cacheKey, JSON.stringify(questions), { expirationTtl: CACHE_TTL_SECONDS })
    return { questions }
  } catch (error) {
    if (holdId)
      await release(deps.db, { workspaceId: scope.workspaceId, holdId }).catch((releaseError) =>
        log.error('ai.follow_ups.release_failed', { holdId, error: releaseError }),
      )
    // 附加请求失败不影响对话，只记录错误（不含提示词与回复正文）
    log.error('ai.follow_ups.failed', { messageId: message.id, error })
    return { questions: [] }
  }
}

/** 生成提示：对象上下文（若有）+ 本轮问答 + 指令；只取本轮，控制附加请求的输入长度 */
async function followUpPrompt(
  db: Database,
  workspaceId: string,
  message: { id: string; conversationId: string; parts: unknown[] },
  count: number,
) {
  const s = scoped(db, workspaceId)
  const [system] = await s
    .select(aiMessage, {
      fields: { role: aiMessage.role, parts: aiMessage.parts },
      where: eq(aiMessage.conversationId, message.conversationId),
    })
    .orderBy(asc(aiMessage.id))
    .limit(1)
  const [question] = await s
    .select(aiMessage, {
      fields: { parts: aiMessage.parts },
      where: and(
        eq(aiMessage.conversationId, message.conversationId),
        inArray(aiMessage.role, ['user']),
        lt(aiMessage.id, message.id),
      ) as SQL,
    })
    .orderBy(desc(aiMessage.id))
    .limit(1)
  const context = system?.role === 'system' ? messageText(system.parts) : ''
  const instruction = [
    `Suggest ${count} short follow-up questions the user is likely to ask next about this conversation.`,
    'Write them in the language the user writes in, from the user’s point of view, each under 80 characters.',
    'Reply with a JSON array of strings only, no other text.',
  ].join(' ')
  return [
    ...(context ? [{ role: 'system' as const, content: context.slice(0, MAX_CONTEXT_CHARS) }] : []),
    {
      role: 'user' as const,
      content: messageText(question?.parts ?? []).slice(0, MAX_TURN_CHARS),
    },
    { role: 'assistant' as const, content: messageText(message.parts).slice(0, MAX_TURN_CHARS) },
    { role: 'user' as const, content: instruction },
  ]
}

/** 解析模型输出：优先 JSON 数组，否则按行拆分；去重、去编号、限长 */
export function parseQuestions(text: string, count: number): string[] {
  let items: unknown[] = []
  const match = text.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown
      if (Array.isArray(parsed)) items = parsed
    } catch {
      items = []
    }
  }
  if (items.length === 0) items = text.split('\n')
  const seen = new Set<string>()
  const questions: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const question = item
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/^["'“]|["'”]$/g, '')
      .trim()
    if (!question || question.length > MAX_QUESTION_LENGTH || seen.has(question)) continue
    seen.add(question)
    questions.push(question)
    if (questions.length >= count) break
  }
  return questions
}
