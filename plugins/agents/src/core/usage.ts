import { actualCredits, estimateTextTokens, MESSAGE_OVERHEAD_TOKENS, type Pricing } from '@saas/ai'

// 轮次用量与积分的纯函数（openspec add-ai-agents 决策 3）：与 Agents SDK、数据库均无关，
// 由轮次服务、实例适配层与 jobs 清理器共用。

/** 一轮的累计用量；跨续轮（确认后、恢复后）累加，写在 ai_agent_turn.usage_checkpoint */
export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  /** 已完成的模型调用步数 */
  readonly steps: number
  /** 截至最后一个检查点已计入用量的可见输出字符数（文本、推理与工具入参），用于估算被驱逐调用的输出 */
  readonly outputChars: number
  /** 含估算（被驱逐调用、停止时未结束的一步）：结算以预扣额封顶 */
  readonly estimated: boolean
}

export const EMPTY_TURN_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  steps: 0,
  outputChars: 0,
  estimated: false,
}

/** 从 usage_checkpoint JSON 读取累计用量；缺失字段按 0 处理 */
export function readTurnUsage(checkpoint: unknown): TurnUsage {
  const value = (checkpoint ?? {}) as Record<string, unknown>
  const num = (key: string) => {
    const raw = value[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  }
  return {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    reasoningTokens: num('reasoningTokens'),
    steps: num('steps'),
    outputChars: num('outputChars'),
    estimated: value.estimated === true,
  }
}

export function addTurnUsage(base: TurnUsage, delta: Partial<TurnUsage>): TurnUsage {
  return {
    inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
    reasoningTokens: base.reasoningTokens + (delta.reasoningTokens ?? 0),
    steps: base.steps + (delta.steps ?? 0),
    outputChars: delta.outputChars ?? base.outputChars,
    estimated: base.estimated || delta.estimated === true,
  }
}

/** 一轮内是否已有可见输出（按次计费与失败退款据此判断） */
export const hasTurnOutput = (usage: TurnUsage) => usage.steps > 0 || usage.outputTokens > 0

/**
 * 一轮的实际积分：按 token 计费对整轮合计取整一次（最低收费只收一次）；
 * 按次计费每次模型调用收一次，至少一次。
 */
export function turnCredits(pricing: Pricing, usage: TurnUsage): number {
  switch (pricing.mode) {
    case 'token':
      return actualCredits(pricing, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    case 'per_call':
      return actualCredits(pricing, {}) * Math.max(1, usage.steps)
    case 'per_unit':
      return 0
  }
}

/**
 * 未正常完成时的积分（与文本对话 `interruptedCredits` 同口径，见 packages/ai/src/text/settle.ts）：
 * - failed 且开启失败全退 → 释放；
 * - failed 无可见输出 → 免费次数内释放，用完后按已记录用量收费；
 * - 其余（停止、过期、有输出的失败）→ 按 token 收已记录用量（不低于最低收费）；
 *   按次在有输出时收费，否则释放。
 * 返回 undefined 表示释放预扣。封顶由调用方负责。
 */
export function interruptedTurnCredits(
  pricing: Pricing,
  usage: TurnUsage,
  options: {
    status: 'stopped' | 'failed' | 'expired'
    failedReplyRefund?: 'no-visible-output' | 'all' | undefined
    freeFailuresExhausted?: boolean
  },
): number | undefined {
  const output = hasTurnOutput(usage)
  if (options.status === 'failed') {
    if (options.failedReplyRefund === 'all') return undefined
    if (!output) return options.freeFailuresExhausted ? turnCredits(pricing, usage) : undefined
  }
  switch (pricing.mode) {
    case 'token':
      return output || usage.inputTokens > 0 ? turnCredits(pricing, usage) : undefined
    case 'per_call':
      return output ? turnCredits(pricing, usage) : undefined
    case 'per_unit':
      return undefined
  }
}

/**
 * 一轮的预扣额（决策 3）：单步预算 × 最大步数，并按 `maxTurnCredits` 与可用余额封顶。
 * 单步预算已由 `planTextBudget` 保证不超过余额；实际消耗超出预扣时走超额容忍与欠费规则。
 */
export function turnHoldAmount(input: {
  stepHold: number
  maxSteps: number
  maxTurnCredits?: number | undefined
  balance: number
}): number {
  const full = input.stepHold * input.maxSteps
  return Math.max(1, Math.min(full, input.maxTurnCredits ?? full, input.balance))
}

/** UI 消息部件中模型产生的可见字符：文本、推理与工具入参（工具输出不是模型输出） */
export function partOutputChars(part: unknown): number {
  if (typeof part !== 'object' || part === null) return 0
  const value = part as { type?: unknown; text?: unknown; input?: unknown }
  if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string')
    return [...value.text].length
  if (
    typeof value.type === 'string' &&
    (value.type.startsWith('tool-') || value.type === 'dynamic-tool') &&
    value.input !== undefined
  )
    return JSON.stringify(value.input)?.length ?? 0
  return 0
}

interface MessageLike {
  readonly id: string
  readonly role: string
  readonly parts: readonly unknown[]
}

/** 最后一条用户消息之后，assistant 消息中已经可见的输出字符数 */
export function outputCharsAfterUser(messages: readonly MessageLike[]): number {
  let total = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as MessageLike
    if (message.role === 'user') break
    if (message.role === 'assistant')
      for (const part of message.parts) total += partOutputChars(part)
  }
  return total
}

/** 最后一条用户消息的 id；没有时返回 undefined */
export function lastUserMessageId(messages: readonly MessageLike[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]?.role === 'user') return messages[index]?.id
  return undefined
}

/** 估算送给模型的输入 token：系统提示词与全部消息部件（含工具输出）按字符保守估算 */
export function estimatePromptTokens(
  system: string,
  messages: readonly MessageLike[],
  tokensPerChar: number,
): number {
  let total = MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(system, tokensPerChar)
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS
    for (const part of message.parts) {
      const value = part as { type?: unknown; text?: unknown; output?: unknown }
      if (typeof value.text === 'string') total += estimateTextTokens(value.text, tokensPerChar)
      else if (typeof value.type === 'string' && value.type !== 'step-start')
        total += Math.ceil(
          (JSON.stringify({
            ...value,
            providerMetadata: undefined,
            callProviderMetadata: undefined,
          })?.length ?? 0) * tokensPerChar,
        )
    }
  }
  return total
}

/** 被驱逐调用的保守估算：输入按调用前估算，输出按检查点之后新增的可见字符 */
export function evictedCallUsage(input: {
  inputTokens: number
  visibleChars: number
  checkpointChars: number
  tokensPerChar: number
}): Partial<TurnUsage> {
  const chars = Math.max(0, input.visibleChars - input.checkpointChars)
  return {
    inputTokens: input.inputTokens,
    outputTokens: Math.ceil(chars * input.tokensPerChar),
    outputChars: Math.max(input.visibleChars, input.checkpointChars),
    estimated: true,
  }
}
