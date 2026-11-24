import type { AvailableModel } from '@saas/ai'
import { log } from '@saas/shared/log'
import {
  convertToModelMessages,
  type LanguageModel,
  type StepResult,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from 'ai'
import { expireTurnApprovals } from '../approval.ts'
import { respondedApprovalIds } from '../core/approvals.ts'
import type { AgentIdentity } from '../core/identity.ts'
import { errorCodeOf, turnLogFields } from '../core/log.ts'
import {
  AGENT_TURN_EXPIRED,
  AGENT_TURN_LIMIT,
  beginTurn,
  type OpenTurn,
  settleAgentTurn,
  type ToolCallRecord,
  type TurnEndStatus,
  type TurnHandle,
  type TurnServiceDeps,
  writeTurnCheckpoint,
} from '../core/turn.ts'
import {
  addTurnUsage,
  lastUserMessageId,
  nextStepExceedsHold,
  outputCharsAfterUser,
  outputCharsForTurn,
  partOutputChars,
  type TurnUsage,
} from '../core/usage.ts'

// 一轮执行的编排（openspec add-ai-agents 决策 3、5，任务 4.3）：只依赖 AI SDK 与轮次服务，
// 不依赖 Agents SDK。实例适配层（agent.ts）提供消息、开放轮次存储与工具集；集成测试直接调用本函数。

/** 开放轮次的存储：实例中为 Durable Object 存储（不放模块级变量，决策 11） */
export interface OpenTurnStore {
  get(): OpenTurn | undefined
  set(turn: OpenTurn): void
  clear(): void
}

export interface AgentTurnDeps extends TurnServiceDeps {
  /** 由模型注册表的可用模型构造 AI SDK 模型；测试注入脚本化模型 */
  readonly languageModel: (model: AvailableModel) => LanguageModel
  /** Durable Object 中的错误上报（Sentry）；只带 id 类标签 */
  readonly captureError?: ((error: unknown, tags: Record<string, string>) => void) | undefined
}

export interface RunAgentTurnInput {
  readonly identity: AgentIdentity
  readonly requestId: string
  readonly messages: UIMessage[]
  /** 按对话固定的 agent id 取系统提示词 */
  readonly systemFor: (agentId: string) => string
  readonly maxStepsFor?: (agentId: string) => number | undefined
  readonly abortSignal?: AbortSignal | undefined
  readonly store: OpenTurnStore
  readonly tools: (turn: { agentId: string; turnId: string; signal: AbortSignal }) => ToolSet
  /**
   * 本实例中仍在进行的轮次（按 turnId）：新消息取代旧轮时立即中止旧轮的生成。
   * 由实例字段持有（不放模块级变量，决策 11）；省略时不中止。
   */
  readonly active?: Map<string, AbortController>
  /** 轮次已过期时把等待中的确认改为过期并持久化 */
  readonly persistMessages?: (messages: UIMessage[]) => Promise<void>
}

export interface AgentTurnOutcome {
  readonly status: TurnEndStatus | 'awaiting_approval'
  readonly turnId: string
  readonly credits?: number | undefined
  readonly usage: TurnUsage
}

export interface AgentTurnRun {
  readonly response: Response
  /** 结算（或进入等待确认）完成 */
  readonly done: Promise<AgentTurnOutcome>
  readonly turn: TurnHandle
}

/** 一步中模型产生的可见字符，与 UI 消息部件的口径一致（usage.ts partOutputChars） */
function stepChars(step: StepResult<ToolSet>): number {
  let total = 0
  for (const part of step.content) {
    if (part.type === 'text' || part.type === 'reasoning')
      total += partOutputChars({ type: part.type, text: part.text })
    else if (part.type === 'tool-call')
      total += partOutputChars({ type: `tool-${part.toolName}`, input: part.input })
  }
  return total
}

function stepToolCalls(
  step: StepResult<ToolSet>,
  durations: Map<string, number>,
): ToolCallRecord[] {
  const calls: ToolCallRecord[] = []
  for (const part of step.content) {
    let call: { toolCallId: string; toolName: string }
    let status: string
    if (part.type === 'tool-result') [call, status] = [part, 'completed']
    else if (part.type === 'tool-error') [call, status] = [part, 'failed']
    else if (part.type === 'tool-approval-request')
      [call, status] = [part.toolCall, 'approval-requested']
    else continue
    const durationMs = durations.get(call.toolCallId)
    calls.push({
      name: call.toolName,
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
    })
  }
  return calls
}

/**
 * 执行一轮（或同一轮的续轮）：轮次服务做调用前检查与预扣 → streamText（tools + stopWhen + abortSignal）
 * → 每步结束写检查点 → 结束时结算；停在等待确认时不结算（决策 5）。
 * 调用前检查失败时抛出 AppError，且不调用模型、不预扣。
 */
export async function runAgentTurn(
  deps: AgentTurnDeps,
  input: RunAgentTurnInput,
): Promise<AgentTurnRun> {
  const { identity, messages, store } = input
  const started = Date.now()
  const userMessageId = lastUserMessageId(messages) ?? input.requestId
  const visibleChars = outputCharsAfterUser(messages)
  const open = store.get()
  let turn: TurnHandle
  try {
    turn = await beginTurn(deps, {
      identity,
      requestId: input.requestId,
      userMessageId,
      systemFor: input.systemFor,
      ...(input.maxStepsFor ? { maxStepsFor: input.maxStepsFor } : {}),
      messages,
      open,
      respondedApprovals: respondedApprovalIds(messages),
      visibleChars,
      ...(open ? { openVisibleChars: outputCharsForTurn(messages, open.userMessageId) } : {}),
      // 估算已写入检查点：立即清除进行中标记，之后再被驱逐也不会重复估算
      onEvictionRecorded: () => {
        const current = store.get()
        if (current) store.set({ ...current, inFlightInputTokens: undefined })
      },
    })
  } catch (error) {
    const code = errorCodeOf(error)
    if (code === AGENT_TURN_EXPIRED || code === AGENT_TURN_LIMIT) {
      store.clear()
      if (code === AGENT_TURN_EXPIRED && input.persistMessages) {
        const expired = expireTurnApprovals(messages, userMessageId)
        if (expired !== messages) await input.persistMessages(expired)
      }
    }
    log.info('agents.turn.rejected', {
      conversationId: identity.conversationId,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      errorCode: code,
    })
    throw error
  }

  // 调用模型前记下「进行中」：实例在本次调用结束前被驱逐时，续轮据此补记估算用量
  store.set({ ...turn.open, inFlightInputTokens: turn.inputTokens })
  // 只有本轮仍是开放轮次时才能改写或清除记录：被新消息取代后不能覆盖新轮的记录
  const ownsOpen = () => store.get()?.turnId === turn.turnId

  const controller = new AbortController()
  if (turn.superseded) input.active?.get(turn.superseded)?.abort('superseded')
  input.active?.set(turn.turnId, controller)
  const signal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, controller.signal])
    : controller.signal
  let usage = turn.usage
  let accountedChars = Math.max(visibleChars, usage.outputChars)
  let liveChars = 0
  let steps = 0
  let aborted = false
  let failure: unknown
  let approvalPending = false
  let pendingApprovals: string[] = []
  const tools = new Set<string>()
  const toolStarts = new Map<string, number>()
  const toolDurations = new Map<string, number>()
  let checkpoints: Promise<unknown> = Promise.resolve()

  const tags = { turnId: turn.turnId, conversationId: identity.conversationId }
  const result = streamText({
    model: deps.languageModel(turn.model),
    system: turn.system,
    messages: await convertToModelMessages(messages),
    tools: input.tools({ agentId: turn.agentId, turnId: turn.turnId, signal }),
    stopWhen: [
      stepCountIs(turn.remainingSteps),
      // 单次运行内也按预扣封顶（决策 3）：已用量加下一步估算超过预扣即不再开始下一步。
      // 用量取自 stopWhen 收到的各步结果，不依赖 onStepEnd 与停止判断的先后。
      ({ steps: done }) => {
        let used = turn.usage
        for (const step of done)
          used = addTurnUsage(used, {
            inputTokens: step.usage.inputTokens ?? turn.inputTokens,
            outputTokens:
              step.usage.outputTokens ?? Math.ceil(stepChars(step) * turn.tokensPerChar),
            steps: 1,
          })
        const last = done.at(-1)
        // 下一步的输入 ≈ 上一步输入 + 上一步输出 + 工具结果（按字符保守估算）
        const toolOutput = last
          ? last.content.reduce(
              (total, part) =>
                part.type === 'tool-result'
                  ? total + (JSON.stringify(part.output)?.length ?? 0)
                  : total,
              0,
            )
          : 0
        const nextInputTokens =
          (last?.usage.inputTokens ?? turn.inputTokens) +
          (last?.usage.outputTokens ?? 0) +
          Math.ceil(toolOutput * turn.tokensPerChar)
        return nextStepExceedsHold({
          pricing: turn.pricing,
          used,
          nextInputTokens,
          maxOutputTokens: turn.maxOutputTokens,
          holdAmount: turn.holdAmount,
        })
      },
    ],
    maxOutputTokens: turn.maxOutputTokens,
    maxRetries: 0,
    abortSignal: signal,
    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        liveChars += [...chunk.text].length
    },
    onToolExecutionStart: (event) => {
      toolStarts.set(event.toolCall.toolCallId, Date.now())
    },
    onToolExecutionEnd: (event) => {
      const start = toolStarts.get(event.toolCall.toolCallId)
      if (start !== undefined) toolDurations.set(event.toolCall.toolCallId, Date.now() - start)
    },
    onStepEnd: (step) => {
      steps += 1
      const chars = stepChars(step)
      const reported = step.usage.inputTokens !== undefined && step.usage.outputTokens !== undefined
      const delta: Partial<TurnUsage> = {
        inputTokens: step.usage.inputTokens ?? turn.inputTokens,
        outputTokens: step.usage.outputTokens ?? Math.ceil(chars * turn.tokensPerChar),
        reasoningTokens: step.usage.outputTokenDetails?.reasoningTokens ?? 0,
        steps: 1,
        outputChars: accountedChars + chars,
        estimated: !reported,
      }
      accountedChars += chars
      liveChars = 0
      usage = addTurnUsage(usage, delta)
      const toolCalls = stepToolCalls(step, toolDurations)
      for (const call of toolCalls) tools.add(call.name)
      checkpoints = checkpoints.then(async () => {
        try {
          const running = await writeTurnCheckpoint(deps.db, {
            workspaceId: identity.workspaceId,
            turnId: turn.turnId,
            delta,
            toolCalls,
          })
          // 轮次已被清理器结算：停止生成，结束时的结算因预扣已结算而跳过
          if (!running) controller.abort('settled')
        } catch (error) {
          log.error('agents.turn.checkpoint_failed', { ...tags, errorCode: errorCodeOf(error) })
          deps.captureError?.(error, tags)
        }
      })
    },
    onEnd: (event) => {
      pendingApprovals =
        event.steps
          .at(-1)
          ?.content.flatMap((part) =>
            part.type === 'tool-approval-request' ? [part.toolCall.toolCallId] : [],
          ) ?? []
      approvalPending = pendingApprovals.length > 0
    },
    onAbort: () => {
      aborted = true
    },
    onError: ({ error }) => {
      failure = error
      log.error('agents.turn.model_failed', { ...tags, errorCode: errorCodeOf(error) })
      deps.captureError?.(error, tags)
    },
  })

  let finishing: Promise<AgentTurnOutcome> | undefined
  let resolveDone!: (outcome: AgentTurnOutcome) => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<AgentTurnOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const finish = () => {
    finishing ??= (async (): Promise<AgentTurnOutcome> => {
      await checkpoints
      input.active?.delete(turn.turnId)
      if (approvalPending && !aborted && failure === undefined && !signal.aborted) {
        // 等待确认：不结算，预扣与开放轮次保留；续轮按开放轮次复用（决策 5）
        if (ownsOpen())
          store.set({ ...turn.open, inFlightInputTokens: undefined, pendingApprovals })
        log.info(
          'agents.turn.awaiting_approval',
          turnLogFields({
            ...identity,
            turnId: turn.turnId,
            status: 'awaiting_approval',
            steps,
            tools: [...tools],
            durationMs: Date.now() - started,
            reused: turn.reused,
          }),
        )
        return { status: 'awaiting_approval', turnId: turn.turnId, usage }
      }
      const status: TurnEndStatus =
        aborted || signal.aborted ? 'stopped' : failure !== undefined ? 'failed' : 'completed'
      let final = usage
      if (status !== 'completed' && liveChars > 0)
        // 停止或失败时未结束的一步拿不到用量：输入按调用前估算，输出按已流出的字符
        final = addTurnUsage(final, {
          inputTokens: turn.inputTokens,
          outputTokens: Math.ceil(liveChars * turn.tokensPerChar),
          estimated: true,
        })
      // 结算前清除进行中标记：结算失败时清理器按检查点兜底，续轮不会对已结束的调用重复估算
      if (ownsOpen()) store.set({ ...turn.open, inFlightInputTokens: undefined })
      let credits: number | undefined
      try {
        const settled = await settleAgentTurn(deps.db, {
          turn: {
            id: turn.turnId,
            workspaceId: identity.workspaceId,
            holdId: turn.holdId,
            pricing: turn.pricing,
          },
          status,
          usage: final,
          overage: deps.overage,
          failedReplyRefund: deps.failedReplyRefund,
          errorCode: failure === undefined ? undefined : errorCodeOf(failure),
          freeFailures: deps.freeFailures,
        })
        credits = settled?.credits
      } catch (error) {
        // 结算失败时保留开放轮次与预扣：清理器到期后按检查点兜底
        log.error('agents.turn.settle_failed', { ...tags, errorCode: errorCodeOf(error) })
        deps.captureError?.(error, tags)
        throw error
      }
      if (ownsOpen()) store.clear()
      log.info(
        'agents.turn.end',
        turnLogFields({
          ...identity,
          turnId: turn.turnId,
          status,
          steps,
          tools: [...tools],
          durationMs: Date.now() - started,
          credits,
          inputTokens: final.inputTokens,
          outputTokens: final.outputTokens,
          reused: turn.reused,
          errorCode: failure === undefined ? undefined : errorCodeOf(failure),
        }),
      )
      return { status, turnId: turn.turnId, credits, usage: final }
    })()
    finishing.then(resolveDone, rejectDone)
    return finishing
  }

  const raw = result.toUIMessageStreamResponse({
    // 界面按 turnId 在每条回答下显示本轮步数与积分（续轮复用同一 turnId）
    messageMetadata: ({ part }) => (part.type === 'start' ? { turnId: turn.turnId } : undefined),
    onError: (error) => {
      failure ??= error
      return 'The agent failed to respond. Please try again.'
    },
  })
  // 结束时机取自响应流本身（读完、出错或被取消），不改动发给 SDK 的分块：
  // UI 流的 onEnd 需要 originalMessages 重建消息，确认后的续轮会因找不到工具调用而报错。
  const reader = (raw.body as ReadableStream<Uint8Array>).getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(sink) {
      try {
        const next = await reader.read()
        if (next.done) {
          sink.close()
          await finish().catch(() => {})
        } else sink.enqueue(next.value)
      } catch (error) {
        failure ??= error
        sink.error(error)
        await finish().catch(() => {})
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
      await finish().catch(() => {})
    },
  })
  const response = new Response(body, { status: raw.status, headers: raw.headers })
  return { response, done, turn }
}
