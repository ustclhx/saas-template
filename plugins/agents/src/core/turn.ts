import {
  type AvailableModel,
  dbModelStore,
  MODEL_UNAVAILABLE,
  type Pricing,
  planTextBudget,
  requireAvailableModel,
  textModelConfig,
  uuidv7Floor,
} from '@saas/ai'
import {
  CreditsError,
  type CreditsTransaction,
  capture,
  getCreditBalance,
  hold,
  lockWorkspaceCredits,
  type OveragePolicy,
  release,
} from '@saas/credits'
import {
  type AiAgentTurn,
  type AiPricingJson,
  aiAgentTurn,
  aiConversation,
  aiModel,
  creditHold,
  type Database,
  getSetting,
  type SettingValues,
  scoped,
  setting,
} from '@saas/db'
import { type Entitlements, getEntitlements } from '@saas/entitlements'
import type { RateLimiter } from '@saas/platform'
import { AppError, newId } from '@saas/shared'
import { and, eq, gte, type SQL, sql } from 'drizzle-orm'
import { checkConversationAccess } from './conversation.ts'
import type { AgentIdentity } from './identity.ts'
import {
  addTurnUsage,
  EMPTY_TURN_USAGE,
  estimatePromptTokens,
  evictedCallUsage,
  hasTurnOutput,
  interruptedTurnCredits,
  readTurnUsage,
  type TurnUsage,
  turnCredits,
  turnHoldAmount,
} from './usage.ts'

// 与 Agents SDK 无关的轮次服务（openspec add-ai-agents 决策 3、5，任务 4.1 / 4.2）：
// 每轮调用前检查、建 ai_agent_turn 与预扣、用量检查点、结算。实例适配层（src/worker/agent.ts）
// 与 jobs 清理器（src/core/sweeper.ts）都从这里调用；规则与文本对话（packages/ai/src/text/settle.ts）一致。

/** 一轮预扣的有效期：等待确认超过它即由清理器按检查点结算并标记 expired（决策 5） */
export const AGENT_TURN_HOLD_TTL_MS = 30 * 60_000

export const AGENT_CONVERSATION_GONE = 'AGENT_CONVERSATION_GONE'
export const AGENT_TURN_EXPIRED = 'AGENT_TURN_EXPIRED'
export const AGENT_TURN_LIMIT = 'AGENT_TURN_LIMIT'

export type FailedReplyRefund = 'no-visible-output' | 'all'
export type TurnEndStatus = 'completed' | 'stopped' | 'failed' | 'expired'

/** 实例存储中的「当前开放轮次」（决策 3「恢复去重」）；只放实例存储，不放模块级变量 */
export interface OpenTurn {
  readonly turnId: string
  readonly holdId: string
  readonly holdAmount: number
  /** 首轮的客户端请求 id，即 chatRecovery 钩子中的 recoveryRootRequestId */
  readonly rootRequestId: string
  readonly userMessageId: string
  /** 单步最大输出（建轮时按余额确定，续轮沿用） */
  readonly maxOutputTokens: number
  /** 调用模型前写入、正常结束后清除；续轮时仍存在说明上次调用被驱逐，按估算补记用量 */
  readonly inFlightInputTokens?: number | undefined
  /** 建轮时模型的估算系数：被驱逐调用的估算在任何入口（续轮、恢复钩子、取代）口径一致 */
  readonly tokensPerChar?: number | undefined
  /** 停在等待确认时记下的工具调用 id；只有这些调用的确认结果才给额外一步（防客户端伪造） */
  readonly pendingApprovals?: readonly string[] | undefined
}

export interface TurnServiceDeps {
  readonly db: Database
  /** `RL_AI`；省略时不限流（测试） */
  readonly rateLimiter?: RateLimiter | undefined
  /** 默认按订阅读取 */
  readonly entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
  readonly pastDueGraceDays?: number | undefined
  /** 目标未装配 Workers AI 时为 false */
  readonly workersAi?: boolean | undefined
  /** 模板关闭多租户时团队空间只读（与文本对话一致） */
  readonly multiTenant: boolean
  readonly overage: OveragePolicy
  readonly failedReplyRefund: FailedReplyRefund
  readonly maxSteps: number
  readonly maxTurnCredits?: number | undefined
  readonly holdTtlMs?: number
  /** 测试可固定免费失败策略；省略时在结算事务内读运行时设置 */
  readonly freeFailures?: SettingValues['ai.freeFailures']
}

export interface BeginTurnInput {
  readonly identity: AgentIdentity
  /** 本次 onChatMessage 的请求 id；新建轮次时作为 turn 的 request_id（首轮即客户端 id） */
  readonly requestId: string
  /** 最后一条用户消息的 id；与开放轮次相同即视为同一轮的续轮 */
  readonly userMessageId: string
  /** 按对话固定的 agent id 取系统提示词（参与输入估算） */
  readonly systemFor: (agentId: string) => string
  /** agent 定义覆盖的最大步数；省略时用插件配置 */
  readonly maxStepsFor?: (agentId: string) => number | undefined
  readonly messages: readonly { id: string; role: string; parts: readonly unknown[] }[]
  readonly open?: OpenTurn | undefined
  /** 消息中已回复确认（approval-responded）的工具调用 id；与开放轮次记下的待确认调用匹配才给额外一步 */
  readonly respondedApprovals?: readonly string[]
  /** 当前可见的输出字符（被驱逐调用的估算依据） */
  readonly visibleChars: number
  /** 被新消息取代的旧轮在消息中已可见的输出字符（旧轮被驱逐调用的估算依据） */
  readonly openVisibleChars?: number
  /** 被驱逐调用的估算已写入检查点：调用方应立即清除开放轮次上的进行中标记，避免重复估算 */
  readonly onEvictionRecorded?: () => void
}

export interface TurnHandle {
  readonly turnId: string
  readonly agentId: string
  readonly system: string
  readonly holdId: string
  readonly holdAmount: number
  readonly pricing: Pricing
  readonly model: AvailableModel
  readonly tokensPerChar: number
  readonly maxOutputTokens: number
  /** 本次调用允许的步数 */
  readonly remainingSteps: number
  /** 截至本次调用前的累计用量（含被驱逐调用的估算） */
  readonly usage: TurnUsage
  readonly reused: boolean
  readonly open: OpenTurn
  /** 本次调用前的输入估算 */
  readonly inputTokens: number
  /** 本次新建轮次时被结算取代的旧轮 id：调用方应立即中止其仍在进行的生成 */
  readonly superseded?: string | undefined
}

const notFound = () => new AppError('NOT_FOUND', 'Not found', { status: 404 })
const modelUnavailable = () =>
  new AppError(MODEL_UNAVAILABLE, 'Model is not available', { status: 404 })

async function resolveModel(
  deps: TurnServiceDeps,
  workspaceId: string,
  modelKey: string,
): Promise<AvailableModel> {
  const [row] = await deps.db
    .select({ id: aiModel.id })
    .from(aiModel)
    .where(eq(aiModel.key, modelKey))
    .limit(1)
  if (!row) throw modelUnavailable()
  const entitlements = await (
    deps.entitlements ??
    ((db, id) =>
      getEntitlements(
        db,
        id,
        deps.pastDueGraceDays === undefined ? {} : { pastDueGraceDays: deps.pastDueGraceDays },
      ))
  )(deps.db, workspaceId)
  // 直接读库，后台关闭「支持工具调用」后下一轮即被拒绝（specs/ai-model-registry）
  return requireAvailableModel(
    { store: dbModelStore(deps.db), workersAi: deps.workersAi },
    entitlements,
    row.id,
    { kind: 'text', requiresTools: true },
  )
}

async function loadTurn(db: Database, workspaceId: string, turnId: string) {
  const [row] = await scoped(db, workspaceId)
    .select(aiAgentTurn, { where: eq(aiAgentTurn.id, turnId) })
    .limit(1)
  return row
}

function handle(
  turn: Pick<AiAgentTurn, 'id' | 'holdId' | 'pricing'>,
  agent: { agentId: string; system: string },
  model: AvailableModel,
  open: OpenTurn,
  usage: TurnUsage,
  remainingSteps: number,
  inputTokens: number,
  reused: boolean,
  superseded?: string,
): TurnHandle {
  return {
    superseded,
    turnId: turn.id,
    ...agent,
    holdId: open.holdId,
    holdAmount: open.holdAmount,
    pricing: turn.pricing as Pricing,
    model,
    tokensPerChar: textModelConfig(model).tokensPerChar,
    maxOutputTokens: open.maxOutputTokens,
    remainingSteps,
    usage,
    reused,
    open,
    inputTokens,
  }
}

/**
 * 开始或续接一轮（任务 4.1，决策 3）。依次检查成员资格、模型权益与工具能力、限流、欠费与余额；
 * 任一不满足抛出与文本对话相同的 AppError，且不调用模型、不预扣。
 *
 * - 有开放轮次且没有新的用户消息：复用该 turn 行与预扣（不再预扣）；上次调用被驱逐时按检查点
 *   加已输出字符补记估算用量，再做预扣封顶检查，超过即按检查点结算并拒绝继续（`AGENT_TURN_LIMIT`）。
 * - 开放轮次在 PG 中已终态（清理器已结算）：同一用户消息的续轮拒绝（`AGENT_TURN_EXPIRED`），
 *   调用方清除开放轮次。
 * - 有新的用户消息而旧轮仍 running：旧轮按检查点以 stopped 结算，再建新轮。
 * - `(conversation_id, request_id)` 已有行时复用该行，不重复预扣。
 */
export async function beginTurn(deps: TurnServiceDeps, input: BeginTurnInput): Promise<TurnHandle> {
  const { db } = deps
  const { workspaceId, userId, conversationId } = input.identity
  const access = await checkConversationAccess(db, input.identity)
  if (access.kind === 'gone')
    throw new AppError(AGENT_CONVERSATION_GONE, 'Not found', { status: 404 })
  if (access.kind === 'denied') throw notFound()
  const { conversation } = access
  if (!deps.multiTenant && !conversation.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  const model = await resolveModel(deps, workspaceId, conversation.modelKey)
  const { tokensPerChar, maxOutputTokens: modelMaxOutput } = textModelConfig(model)
  const agent = { agentId: conversation.agentId, system: input.systemFor(conversation.agentId) }
  const inputTokens = estimatePromptTokens(agent.system, input.messages, tokensPerChar)
  const maxSteps = input.maxStepsFor?.(conversation.agentId) ?? deps.maxSteps

  let superseded: string | undefined
  if (input.open) {
    const open = input.open
    const turn = await loadTurn(db, workspaceId, open.turnId)
    const sameTurn = open.userMessageId === input.userMessageId
    if (turn?.status !== 'running') {
      if (sameTurn)
        throw new AppError(AGENT_TURN_EXPIRED, 'This agent turn has expired', { status: 409 })
    } else if (sameTurn) {
      let usage = readTurnUsage(turn.usageCheckpoint)
      if (open.inFlightInputTokens !== undefined) {
        // 被驱逐的那次调用拿不到用量：输入按调用前估算，输出按检查点之后新增的可见字符（决策 3）
        const delta = evictedCallUsage({
          inputTokens: open.inFlightInputTokens,
          visibleChars: input.visibleChars,
          checkpointChars: usage.outputChars,
          tokensPerChar: open.tokensPerChar ?? tokensPerChar,
        })
        await writeTurnCheckpoint(db, { workspaceId, turnId: turn.id, delta })
        input.onEvictionRecorded?.()
        usage = addTurnUsage(usage, delta)
      }
      const pricing = turn.pricing as Pricing
      const left = maxSteps - usage.steps
      // 只有开放轮次记下的待确认调用得到回复时才给额外一步；客户端无法靠伪造确认部件多拿步数
      const resolvingApproval =
        open.pendingApprovals?.some((id) => input.respondedApprovals?.includes(id)) ?? false
      const remainingSteps = resolvingApproval ? Math.max(1, left) : left
      if (turnCredits(pricing, usage) >= open.holdAmount || remainingSteps <= 0) {
        // 预扣封顶或步数用尽：按检查点结算，不再调用模型（每次续跑开始时检查，决策 3）
        await settleAgentTurn(db, {
          turn: { ...turn, holdId: open.holdId },
          status: remainingSteps <= 0 ? 'completed' : 'stopped',
          usage: { ...usage, estimated: true },
          overage: deps.overage,
          failedReplyRefund: deps.failedReplyRefund,
          errorCode: remainingSteps <= 0 ? 'STEP_LIMIT' : 'TURN_BUDGET_EXCEEDED',
          freeFailures: deps.freeFailures,
        })
        throw new AppError(AGENT_TURN_LIMIT, 'This agent turn reached its limit', { status: 409 })
      }
      await touchConversation(db, workspaceId, conversationId)
      return handle(
        turn,
        agent,
        model,
        { ...open, inFlightInputTokens: undefined, pendingApprovals: undefined, tokensPerChar },
        usage,
        remainingSteps,
        inputTokens,
        true,
      )
    } else {
      // 用户在旧轮未结束（例如等待确认）时发来新消息：旧轮按已记录用量结束；
      // 旧轮仍有进行中（或被驱逐）的调用时，一并按估算补记
      const recorded = readTurnUsage(turn.usageCheckpoint)
      await settleAgentTurn(db, {
        turn: { ...turn, holdId: open.holdId },
        status: 'stopped',
        usage:
          open.inFlightInputTokens === undefined
            ? recorded
            : addTurnUsage(
                recorded,
                evictedCallUsage({
                  inputTokens: open.inFlightInputTokens,
                  visibleChars: input.openVisibleChars ?? 0,
                  checkpointChars: recorded.outputChars,
                  tokensPerChar: open.tokensPerChar ?? tokensPerChar,
                }),
              ),
        overage: deps.overage,
        failedReplyRefund: deps.failedReplyRefund,
        errorCode: 'SUPERSEDED',
        freeFailures: deps.freeFailures,
      })
      superseded = open.turnId
    }
  }

  // 新的一轮：限流（按数据中心计数，只用于防刷）
  if (
    deps.rateLimiter &&
    !(await deps.rateLimiter.limit('ai', `ai:${workspaceId}:${userId}`)).success
  )
    throw new AppError('RATE_LIMITED', 'Too many requests, please try again later', { status: 429 })
  const balance = await getCreditBalance(db, workspaceId)
  if (balance.debt > 0)
    throw new AppError('CREDIT_DEBT', 'Workspace has unpaid credit debt', { status: 402 })
  // 单步预算沿用文本对话的 planTextBudget：余额不足一步的最低输出时抛出 INSUFFICIENT_CREDITS
  const step = planTextBudget({
    pricing: model.pricing,
    inputTokens,
    balance: balance.available,
    maxOutputTokens: modelMaxOutput,
  })
  const holdAmount = turnHoldAmount({
    stepHold: step.holdAmount,
    maxSteps,
    maxTurnCredits: deps.maxTurnCredits,
    balance: balance.available,
  })
  const turnId = newId()
  const expiresAt = new Date(Date.now() + (deps.holdTtlMs ?? AGENT_TURN_HOLD_TTL_MS))
  const created = await db
    .transaction(async (tx) => {
      const reservation = await hold(tx, {
        workspaceId,
        userId,
        amount: holdAmount,
        refType: 'agent_turn',
        refId: turnId,
        expiresAt,
      })
      const rows = await scoped(tx, workspaceId)
        .insert(aiAgentTurn, {
          id: turnId,
          userId,
          conversationId,
          requestId: input.requestId,
          modelKey: model.key,
          pricing: model.pricing as AiPricingJson,
          holdId: reservation.id,
          usageCheckpoint: {
            ...EMPTY_TURN_USAGE,
            // 发起时的策略快照：清理器按它结算，在途配置变化不改变口径
            failedReplyRefund: deps.failedReplyRefund,
            at: new Date().toISOString(),
          },
        })
        .onConflictDoNothing()
        .returning({ id: aiAgentTurn.id })
      // 同一 (对话, 请求 id) 已建过行：回滚本次预扣，复用已有行（重复建行的最后防线）
      if (rows.length === 0) throw new DuplicateTurn()
      await scoped(tx, workspaceId).update(
        aiConversation,
        { updatedAt: new Date() },
        eq(aiConversation.id, conversationId),
      )
      return reservation
    })
    .catch(async (error) => {
      if (!(error instanceof DuplicateTurn)) throw error
      return undefined
    })
  if (!created) {
    const [existing] = await scoped(db, workspaceId)
      .select(aiAgentTurn, {
        where: and(
          eq(aiAgentTurn.conversationId, conversationId),
          eq(aiAgentTurn.requestId, input.requestId),
        ) as SQL,
      })
      .limit(1)
    if (existing?.status !== 'running' || !existing.holdId)
      throw new AppError(AGENT_TURN_EXPIRED, 'This agent turn has expired', { status: 409 })
    const [reservation] = await scoped(db, workspaceId)
      .select(creditHold, {
        where: eq(creditHold.id, existing.holdId),
        fields: { amount: creditHold.amount },
      })
      .limit(1)
    const open: OpenTurn = {
      turnId: existing.id,
      holdId: existing.holdId,
      holdAmount: reservation?.amount ?? holdAmount,
      rootRequestId: input.requestId,
      userMessageId: input.userMessageId,
      maxOutputTokens: step.maxOutputTokens,
      tokensPerChar,
    }
    const usage = readTurnUsage(existing.usageCheckpoint)
    return handle(
      existing,
      agent,
      model,
      open,
      usage,
      Math.max(0, maxSteps - usage.steps),
      inputTokens,
      true,
      superseded,
    )
  }
  const open: OpenTurn = {
    turnId,
    holdId: created.id,
    holdAmount,
    rootRequestId: input.requestId,
    userMessageId: input.userMessageId,
    maxOutputTokens: step.maxOutputTokens,
    tokensPerChar,
  }
  return handle(
    { id: turnId, holdId: created.id, pricing: model.pricing as AiPricingJson },
    agent,
    model,
    open,
    EMPTY_TURN_USAGE,
    maxSteps,
    inputTokens,
    false,
    superseded,
  )
}

class DuplicateTurn extends Error {}

async function touchConversation(db: Database, workspaceId: string, conversationId: string) {
  await scoped(db, workspaceId).update(
    aiConversation,
    { updatedAt: new Date() },
    eq(aiConversation.id, conversationId),
  )
}

export interface ToolCallRecord {
  readonly name: string
  readonly status: string
  readonly durationMs?: number
}

/**
 * 用量检查点（每步结束、补记被驱逐调用时）：在 SQL 中累加，续轮与并发写入都不会丢失已记录的用量。
 * 只更新仍为 running 的轮次；返回 false 表示轮次已被结算（清理器或停止），调用方应中止生成。
 */
export async function writeTurnCheckpoint(
  db: Database,
  input: {
    workspaceId: string
    turnId: string
    delta: Partial<TurnUsage>
    toolCalls?: readonly ToolCallRecord[]
  },
): Promise<boolean> {
  const { delta } = input
  const add = (key: keyof TurnUsage, value: number | undefined) =>
    sql`coalesce((${aiAgentTurn.usageCheckpoint}->>${key})::bigint, 0) + ${Math.max(0, Math.floor(value ?? 0))}`
  const checkpoint = sql`coalesce(${aiAgentTurn.usageCheckpoint}, '{}'::jsonb) || jsonb_build_object(
    'inputTokens', ${add('inputTokens', delta.inputTokens)},
    'outputTokens', ${add('outputTokens', delta.outputTokens)},
    'reasoningTokens', ${add('reasoningTokens', delta.reasoningTokens)},
    'steps', ${add('steps', delta.steps)},
    'outputChars', ${
      delta.outputChars === undefined
        ? sql`coalesce((${aiAgentTurn.usageCheckpoint}->>'outputChars')::bigint, 0)`
        : sql`${Math.max(0, Math.floor(delta.outputChars))}::bigint`
    },
    'estimated', coalesce((${aiAgentTurn.usageCheckpoint}->>'estimated')::boolean, false) or ${delta.estimated === true},
    'at', ${new Date().toISOString()}::text
  )`
  const rows = await scoped(db, input.workspaceId)
    .update(
      aiAgentTurn,
      {
        usageCheckpoint: checkpoint,
        steps: sql`${aiAgentTurn.steps} + ${Math.max(0, Math.floor(delta.steps ?? 0))}`,
        ...(input.toolCalls?.length
          ? {
              toolCalls: sql`${aiAgentTurn.toolCalls} || ${JSON.stringify(input.toolCalls)}::jsonb`,
            }
          : {}),
      },
      and(eq(aiAgentTurn.id, input.turnId), eq(aiAgentTurn.status, 'running')) as SQL,
    )
    .returning({ id: aiAgentTurn.id })
  return rows.length > 0
}

export interface SettleTurnInput {
  readonly turn: Pick<AiAgentTurn, 'id' | 'workspaceId' | 'pricing'> & { holdId: string }
  readonly status: TurnEndStatus
  /** 截至结算的累计用量（completed 时为检查点加最后一步） */
  readonly usage: TurnUsage
  readonly overage: OveragePolicy
  readonly failedReplyRefund: FailedReplyRefund
  readonly errorCode?: string | undefined
  readonly freeFailures?: SettingValues['ai.freeFailures'] | undefined
}

export interface TurnSettlement {
  /** 空间实际支付的积分（不含平台承担的超额） */
  readonly credits: number
}

/** 同一预扣已被另一方结算时返回 null（预扣状态是闸门，见 @saas/credits） */
async function once<T>(
  db: Database,
  tx: CreditsTransaction | undefined,
  fn: (tx: CreditsTransaction) => Promise<T>,
): Promise<T | null> {
  if (tx) return fn(tx)
  try {
    return await db.transaction(fn)
  } catch (error) {
    if (error instanceof CreditsError && error.code === 'HOLD_NOT_ACTIVE') return null
    throw error
  }
}

/** 窗口内的免费失败次数是否已用完：agent 轮次单独计数（failed 且未收费的轮次），须在积分锁内调用 */
async function freeFailuresExhausted(
  tx: CreditsTransaction,
  workspaceId: string,
  policy: SettingValues['ai.freeFailures'] | undefined,
): Promise<boolean> {
  const { count, windowSeconds } =
    policy ??
    (await getSetting(
      {
        store: {
          async find(key) {
            const [row] = await tx
              .select({ value: setting.value })
              .from(setting)
              .where(eq(setting.key, key))
              .limit(1)
            return row?.value
          },
        },
      },
      'ai.freeFailures',
    ))
  const used = await scoped(tx, workspaceId).count(
    aiAgentTurn,
    and(
      gte(aiAgentTurn.id, uuidv7Floor(Date.now() - windowSeconds * 1000)),
      eq(aiAgentTurn.status, 'failed'),
      eq(aiAgentTurn.creditsCharged, 0),
    ) as SQL,
  )
  return used >= count
}

/**
 * 结算一轮（任务 4.2）：正常完成按累计用量与定价快照 capture，真实用量超出预扣走超额容忍与欠费；
 * 含估算的用量、停止、失败与过期都以预扣额封顶（与文本对话一致）。同一事务内把 turn 标记为终态。
 * 传入 `tx` 时在调用方事务中执行（清理器）；预扣已被另一方结算时返回 null，不重复结算。
 */
export function settleAgentTurn(
  db: Database,
  input: SettleTurnInput,
  tx?: CreditsTransaction,
): Promise<TurnSettlement | null> {
  const { turn, usage, status } = input
  const pricing = turn.pricing as Pricing
  return once(db, tx, async (tx) => {
    const counted =
      status === 'failed' &&
      !hasTurnOutput(usage) &&
      input.failedReplyRefund !== 'all' &&
      pricing.mode !== 'per_unit'
    if (counted) await lockWorkspaceCredits(tx, turn.workspaceId)
    const exhausted =
      counted && (await freeFailuresExhausted(tx, turn.workspaceId, input.freeFailures))
    let amount =
      status === 'completed'
        ? turnCredits(pricing, usage)
        : interruptedTurnCredits(pricing, usage, {
            status,
            failedReplyRefund: input.failedReplyRefund,
            freeFailuresExhausted: exhausted,
          })
    if (amount !== undefined && (status !== 'completed' || usage.estimated)) {
      const [reservation] = await scoped(tx, turn.workspaceId)
        .select(creditHold, {
          where: eq(creditHold.id, turn.holdId),
          fields: { amount: creditHold.amount },
        })
        .limit(1)
      if (!reservation) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
      amount = Math.min(amount, reservation.amount)
    }
    const reservation = { workspaceId: turn.workspaceId, holdId: turn.holdId }
    let credits = 0
    if (amount === undefined || amount <= 0) await release(tx, reservation, tx)
    else {
      const settlement = await capture(
        tx,
        { ...reservation, actualAmount: amount, overage: input.overage },
        tx,
      )
      credits = settlement.captured + settlement.debited
    }
    await scoped(tx, turn.workspaceId).update(
      aiAgentTurn,
      {
        status,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
        },
        creditsCharged: credits,
        errorCode: input.errorCode ?? null,
      },
      eq(aiAgentTurn.id, turn.id),
    )
    return { credits }
  })
}

/** 按 turn 行上的检查点结算（停止跨实例、清理器、开放轮次被新消息取代） */
export function settleTurnFromCheckpoint(
  db: Database,
  turn: Pick<AiAgentTurn, 'id' | 'workspaceId' | 'pricing' | 'usageCheckpoint'> & {
    holdId: string
  },
  options: {
    status: Exclude<TurnEndStatus, 'completed'>
    overage: OveragePolicy
    failedReplyRefund: FailedReplyRefund
    errorCode?: string
    freeFailures?: SettingValues['ai.freeFailures']
  },
  tx?: CreditsTransaction,
): Promise<TurnSettlement | null> {
  return settleAgentTurn(
    db,
    {
      turn,
      status: options.status,
      usage: { ...readTurnUsage(turn.usageCheckpoint), estimated: true },
      overage: options.overage,
      failedReplyRefund: options.failedReplyRefund,
      errorCode: options.errorCode,
      freeFailures: options.freeFailures,
    },
    tx,
  )
}
