import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import { DEFAULT_TOKENS_PER_CHAR, type Pricing } from '@saas/ai'
import { aiAgentTurn, scoped } from '@saas/db'
import { AppError, toErrorResponse } from '@saas/shared'
import { utcDay } from '@saas/shared/bulk-job'
import { log } from '@saas/shared/log'
import { captureException } from '@sentry/cloudflare'
import { eq } from 'drizzle-orm'
import { expireTurnApprovals } from '../approval.ts'
import {
  applyTaskResults,
  findPendingTasks,
  readTaskResults,
  taskPollDelaySeconds,
} from '../core/async-tasks.ts'
import { checkConversationAccess } from '../core/conversation.ts'
import { type AgentOwner, checkOwner, readIdentity } from '../core/identity.ts'
import { nextLifecycleCheck, reviewAgentConversation } from '../core/lifecycle.ts'
import { errorCodeOf } from '../core/log.ts'
import {
  AGENT_CONVERSATION_GONE,
  type OpenTurn,
  settleAgentTurn,
  type TurnServiceDeps,
} from '../core/turn.ts'
import {
  addTurnUsage,
  evictedCallUsage,
  outputCharsAfterUser,
  readTurnUsage,
  type TurnUsage,
  turnCredits,
} from '../core/usage.ts'
import { getAgent, resolveAgentTools } from '../registry.ts'
import { agentsConfig } from './config.ts'
import { type AgentEnv, createAgentTurnDeps } from './deps.ts'
import { type OpenTurnStore, runAgentTurn } from './runner.ts'
import { createToolServices } from './services.ts'

// 每个 agent 对话一个实例（openspec add-ai-agents 决策 1），实例名为 PG ai_conversation.id。
// 本文件是 Agents SDK 的适配层（决策 10）：身份比对（3.2）、开放轮次存储、chatRecovery 与 SDK 钩子；
// 调用前检查、预扣与结算在 src/core/turn.ts，编排在 runner.ts，均与 SDK 无关。
// 租户状态只放实例字段或实例存储，不放模块级变量（决策 11）。

const OWNER_KEY = 'agents:owner'
const OPEN_TURN_KEY = 'agents:open-turn'
/** 已安排的空闲检查（7.2 自清理 / 7.3 保留期）：同一时刻只保留一个 */
const LIFECYCLE_KEY = 'agents:lifecycle-check'
/** 已安排的异步任务轮询（8.2）与当前退避次数 */
const TASK_POLL_KEY = 'agents:task-poll'

interface ScheduledCheck {
  readonly id: string
  readonly at: number
}
interface TaskPoll {
  readonly id: string
  readonly attempt: number
}

const { maxPersistedMessages, retentionDays } = agentsConfig

export class AgentConversation extends AIChatAgent<Cloudflare.Env> {
  override maxPersistedMessages = maxPersistedMessages

  // 必须写成类字段：SDK 在每次唤醒时先评估恢复预算，再运行 onStart（见 AIChatAgent.chatRecovery 注释）
  override chatRecovery = {
    maxInterruptedAttempts: 2,
    // 第二次及以后的恢复尝试前调用（第一次恢复不调用）；每次续跑开始时 runner 也会做同样的封顶检查，
    // 这里只是补充：本轮已记录消耗达到预扣封顶时返回 false（reason = recovery_aborted）。
    shouldKeepRecovering: async (ctx: { recoveryRootRequestId: string; attempt: number }) => {
      const keep = await this.withinTurnBudget(ctx.recoveryRootRequestId)
      log.info('agents.recovery.check', {
        conversationId: this.ctx.id.name,
        attempt: ctx.attempt,
        keep,
      })
      return keep
    },
    onExhausted: async (ctx: {
      recoveryRootRequestId: string
      attempt: number
      reason: string
    }) => {
      log.warn('agents.recovery.exhausted', {
        conversationId: this.ctx.id.name,
        attempt: ctx.attempt,
        reason: ctx.reason,
      })
      await this.settleExhausted(ctx.recoveryRootRequestId)
    },
  }

  private readonly openTurns: OpenTurnStore = {
    get: () => this.ctx.storage.kv.get<OpenTurn>(OPEN_TURN_KEY),
    set: (turn) => this.ctx.storage.kv.put(OPEN_TURN_KEY, turn),
    clear: () => {
      this.ctx.storage.kv.delete(OPEN_TURN_KEY)
    },
  }

  /** 本实例中仍在进行的轮次，新消息取代旧轮时据此中止旧轮（实例字段，不放模块级变量） */
  private readonly activeTurns = new Map<string, AbortController>()

  private owner(): AgentOwner | undefined {
    return this.ctx.storage.kv.get<AgentOwner>(OWNER_KEY)
  }

  private turnDeps() {
    return createAgentTurnDeps(this.env as unknown as AgentEnv, (error, tags) =>
      captureException(error, { tags }),
    )
  }

  /**
   * 实例侧身份比对（任务 3.2）：Durable Object 只能经本 Worker 的前置处理访问，实例只信任其写入的
   * x-saas-* 头；首次请求记住归属，之后每个请求（WebSocket 升级与 HTTP，含 get-messages）都比对，
   * 不一致返回 403 并记安全日志。
   */
  override async fetch(request: Request): Promise<Response> {
    const name = this.ctx.id.name ?? ''
    const check = checkOwner(this.owner(), readIdentity(request.headers), name)
    if (!check.ok) {
      log.warn('agents.security.identity_mismatch', { conversationId: name, reason: check.reason })
      return Response.json(
        toErrorResponse(new AppError('FORBIDDEN', 'Forbidden', { status: 403 })).body,
        { status: 403 },
      )
    }
    if (check.first) {
      this.ctx.storage.kv.put(OWNER_KEY, check.owner)
      // 只有存在过的实例才会被唤醒检查：首次记住归属时安排空闲检查（7.2 兜底）
      await this.ensureLifecycleCheck(new Date())
    }
    return super.fetch(request)
  }

  /** 不使用子 agent：经路由到达的子 agent 路径一律 404 */
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  }

  /** 客户端连接时处理已被清理器结算的开放轮次（任务 4.4） */
  override async onConnect(
    ...args: Parameters<AIChatAgent<Cloudflare.Env>['onConnect']>
  ): Promise<void> {
    try {
      await this.reconcileOpenTurn()
    } catch (error) {
      log.error('agents.turn.reconcile_failed', {
        conversationId: this.ctx.id.name,
        errorCode: errorCodeOf(error),
      })
    }
    // 客户端连接时立即检查待完成的异步任务（8.2）；部署前创建的实例在此补上空闲检查
    await this.checkAgentTasks().catch((error) => this.logTaskCheckFailed(error))
    await this.ensureLifecycleCheck(new Date()).catch(() => {})
    return super.onConnect(...args)
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const owner = this.owner()
    const conversationId = this.ctx.id.name
    if (!owner || !conversationId) throw rejection(new AppError('FORBIDDEN', 'Forbidden'))
    const deps = this.turnDeps()
    const requestId = options?.requestId ?? crypto.randomUUID()
    // 新一轮开始前先写回已完成的异步任务结果（8.2），模型能在本轮看到
    await this.checkAgentTasks().catch((error) => this.logTaskCheckFailed(error))
    try {
      const run = await runAgentTurn(deps, {
        identity: { ...owner, conversationId },
        requestId,
        messages: this.messages,
        systemFor: (agentId) => {
          const agent = getAgent(agentId)
          if (!agent) throw new AppError('NOT_FOUND', 'Agent not found', { status: 404 })
          return agent.systemPrompt({ ...owner, conversationId })
        },
        maxStepsFor: (agentId) => getAgent(agentId)?.maxSteps,
        abortSignal: options?.abortSignal,
        store: this.openTurns,
        active: this.activeTurns,
        tools: ({ agentId, turnId, signal }) =>
          resolveAgentTools(agentId, {
            workspaceId: owner.workspaceId,
            userId: owner.userId,
            conversationId,
            turnId,
            db: deps.db,
            signal,
            log,
            services: createToolServices(this.env),
          }),
        persistMessages: (messages) => this.persistMessages(messages),
      })
      this.ctx.waitUntil(
        run.done
          .catch(() => {})
          .then(() => this.afterTurn())
          .catch(() => {}),
      )
      return run.response
    } catch (error) {
      if (errorCodeOf(error) === AGENT_CONVERSATION_GONE) {
        // PG 中对话已删除：拒绝并自清理（任务 3.2）。在新的 alarm 调用中执行，避免在本轮中清空存储
        log.warn('agents.conversation.gone', { conversationId })
        await this.schedule(1, 'purgeIfDeleted')
      } else if (!(error instanceof AppError) || error.status >= 500) {
        captureException(error, { tags: { conversationId } })
      }
      throw rejection(error)
    }
  }

  /**
   * alarm 回调：PG 中对话确实不存在（或已删除）时清空实例（`destroy()` 删除全部存储与 alarm）。
   * 没有记住归属的实例从未保存过对话内容，直接清空。
   */
  async purgeIfDeleted() {
    const owner = this.owner()
    const conversationId = this.ctx.id.name
    if (owner && conversationId) {
      const access = await checkConversationAccess(this.turnDeps().db, {
        ...owner,
        conversationId,
      })
      if (access.kind !== 'gone') return
    }
    log.warn('agents.instance.purged', { conversationId, reason: owner ? 'gone' : 'unowned' })
    await this.destroy()
  }

  /**
   * web 内经 Durable Object RPC 调用的实例清理（7.1 删除对话、7.2 删号 / 删空间）。只安排一次立即的
   * alarm，由 `purgeIfDeleted` 在新的调用中核对 PG 后清空：RPC 不能清空仍存在的对话，
   * 且 `destroy()` 会中止实例，不在 RPC 调用中直接执行。
   */
  async requestPurge(): Promise<void> {
    await this.schedule(1, 'purgeIfDeleted')
  }

  /**
   * 空闲检查 alarm（7.2 自清理兜底、7.3 保留期）：对话不存在或已删除 → 清空；超出保留期且没有
   * running 轮次 → 删除 PG 行并清空；否则按最近活动顺延。
   */
  async checkLifecycle() {
    this.ctx.storage.kv.delete(LIFECYCLE_KEY)
    const owner = this.owner()
    const conversationId = this.ctx.id.name
    if (!owner || !conversationId) {
      await this.purgeIfDeleted()
      return
    }
    const review = await reviewAgentConversation(this.turnDeps().db, {
      workspaceId: owner.workspaceId,
      conversationId,
      retentionDays,
    })
    if (review.action === 'reschedule') {
      if (review.reason === 'guard') await this.alertRetentionGuard(review.tripped)
      await this.ensureLifecycleCheck(review.at)
      return
    }
    log.warn('agents.instance.purged', {
      conversationId,
      reason: review.action === 'expired' ? 'retention' : review.reason,
    })
    await this.destroy()
  }

  /**
   * 保留期时间防护未通过时经运维通知告警（add-ops-safeguards D3）；sourceId 按任务 + 原因 + UTC 日去重，
   * 多个实例同日触发只投递一次。队列不可用时只留日志，不影响 alarm 顺延。
   */
  private async alertRetentionGuard(reason: string) {
    const queue = (this.env as { EVENTS_QUEUE?: { send(body: unknown): Promise<unknown> } })
      .EVENTS_QUEUE
    try {
      await queue?.send({
        v: 1,
        operations: [
          {
            event: 'ops.bulk_job.guard_tripped',
            sourceId: `bulk_job:agents-retention:${reason}:${utcDay(new Date())}`,
          },
        ],
      })
    } catch {
      log.warn('operations.enqueue_failed', { event: 'ops.bulk_job.guard_tripped' })
    }
  }

  /** 异步任务轮询 alarm（8.2）：仍有待完成任务时按退避再次安排 */
  async pollAgentTasks(payload?: { attempt?: number }) {
    this.ctx.storage.kv.delete(TASK_POLL_KEY)
    const attempt = payload?.attempt ?? 0
    const remaining = await this.checkAgentTasks()
    if (remaining > 0) await this.scheduleTaskPoll(attempt + 1)
  }

  /** 安排空闲检查；已有检查时保留原时间（到期时按 PG 的最近活动顺延） */
  private async ensureLifecycleCheck(at: Date) {
    if (this.ctx.storage.kv.get<ScheduledCheck>(LIFECYCLE_KEY)) return
    const when =
      at.getTime() > Date.now() + 1000
        ? at
        : nextLifecycleCheck({ now: new Date(), lastActivity: new Date(), retentionDays })
    const schedule = await this.schedule(when, 'checkLifecycle')
    this.ctx.storage.kv.put(LIFECYCLE_KEY, { id: schedule.id, at: when.getTime() })
  }

  /** 一轮结束（含等待确认）后：保证有空闲检查，并开始轮询本轮可能提交的异步任务 */
  private async afterTurn() {
    await this.ensureLifecycleCheck(new Date())
    await this.scheduleTaskPoll(0, { restart: true })
  }

  private async scheduleTaskPoll(attempt: number, options?: { restart?: boolean }) {
    const existing = this.ctx.storage.kv.get<TaskPoll>(TASK_POLL_KEY)
    if (existing) {
      if (!options?.restart || existing.attempt === 0) return
      await this.cancelSchedule(existing.id)
    }
    const schedule = await this.schedule(taskPollDelaySeconds(attempt), 'pollAgentTasks', {
      attempt,
    })
    this.ctx.storage.kv.put(TASK_POLL_KEY, { id: schedule.id, attempt })
  }

  /**
   * 读取消息中仍为 pending 的异步任务，终态的写回结果部件（只改消息、不调用模型、不自动续轮）。
   * 返回仍待完成的任务数；有轮次在流式输出时不写消息，留给下一次轮询。
   */
  private async checkAgentTasks(): Promise<number> {
    const pending = findPendingTasks(this.messages)
    const owner = this.owner()
    if (pending.length === 0 || !owner) return 0
    if (this.activeTurns.size > 0) return pending.length
    const results = await readTaskResults(this.turnDeps().db, owner.workspaceId, pending)
    if (results.size > 0) {
      const updated = applyTaskResults(this.messages, results)
      if (updated !== this.messages) await this.persistMessages(updated)
      log.info('agents.task.results', {
        conversationId: this.ctx.id.name,
        resolved: results.size,
        remaining: pending.length - results.size,
      })
    }
    return pending.length - results.size
  }

  private logTaskCheckFailed(error: unknown) {
    log.error('agents.task.check_failed', {
      conversationId: this.ctx.id.name,
      errorCode: errorCodeOf(error),
    })
  }

  /** 开放轮次在 PG 中已终态（清理器结算）时清除，并把等待中的确认标记为过期（任务 4.4） */
  private async reconcileOpenTurn() {
    const open = this.openTurns.get()
    const owner = this.owner()
    if (!open || !owner || open.inFlightInputTokens !== undefined) return
    const turn = await this.loadTurn(owner, open.turnId)
    if (turn?.status === 'running') return
    this.openTurns.clear()
    const expired = expireTurnApprovals(this.messages, open.userMessageId)
    if (expired !== this.messages) await this.persistMessages(expired)
    log.info('agents.turn.reconciled', {
      conversationId: this.ctx.id.name,
      turnId: open.turnId,
      status: turn?.status ?? 'missing',
    })
  }

  /** 本轮已记录消耗（检查点 + 被驱逐调用的估算）是否仍低于预扣封顶 */
  private async withinTurnBudget(rootRequestId: string): Promise<boolean> {
    const open = this.openTurns.get()
    const owner = this.owner()
    if (!open || !owner || open.rootRequestId !== rootRequestId) return true
    const turn = await this.loadTurn(owner, open.turnId)
    if (turn?.status !== 'running') return false
    const usage = this.withEvicted(open, readTurnUsage(turn.usageCheckpoint))
    return turnCredits(turn.pricing as Pricing, usage) < open.holdAmount
  }

  /** 恢复预算用尽：按检查点（含被驱逐调用的估算）结算本轮并清除开放轮次 */
  private async settleExhausted(rootRequestId: string) {
    const open = this.openTurns.get()
    const owner = this.owner()
    if (!open || !owner || open.rootRequestId !== rootRequestId) return
    const deps: TurnServiceDeps = this.turnDeps()
    const turn = await this.loadTurn(owner, open.turnId)
    if (turn?.status === 'running')
      await settleAgentTurn(deps.db, {
        turn: { ...turn, holdId: open.holdId },
        status: 'failed',
        usage: this.withEvicted(open, readTurnUsage(turn.usageCheckpoint)),
        overage: deps.overage,
        failedReplyRefund: deps.failedReplyRefund,
        errorCode: 'RECOVERY_EXHAUSTED',
      })
    this.openTurns.clear()
  }

  /** 被驱逐调用的保守估算：输入按调用前估算，输出按检查点之后新增的可见字符（每字符 1 token） */
  private withEvicted(open: OpenTurn, usage: TurnUsage) {
    if (open.inFlightInputTokens === undefined) return usage
    return addTurnUsage(
      usage,
      evictedCallUsage({
        inputTokens: open.inFlightInputTokens,
        visibleChars: outputCharsAfterUser(this.messages),
        checkpointChars: usage.outputChars,
        // 与续轮的估算同一口径（建轮时记下的模型系数）
        tokensPerChar: open.tokensPerChar ?? DEFAULT_TOKENS_PER_CHAR,
      }),
    )
  }

  private async loadTurn(owner: AgentOwner, turnId: string) {
    const [turn] = await scoped(this.turnDeps().db, owner.workspaceId)
      .select(aiAgentTurn, { where: eq(aiAgentTurn.id, turnId) })
      .limit(1)
    return turn
  }
}

/**
 * 拒绝时抛给 SDK 的错误：SDK 把 message 作为错误帧发给客户端（`_reportTurnFailure`），
 * 这里放 `toErrorResponse` 的 JSON，界面按 `error.code` 复用现有对话的提示与充值入口。
 */
function rejection(error: unknown): Error {
  const { body } = toErrorResponse(error)
  return new Error(JSON.stringify(body))
}
