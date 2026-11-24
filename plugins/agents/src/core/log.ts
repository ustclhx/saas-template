// 每轮结构化日志的字段白名单（openspec add-ai-agents 任务 4.5）：只记 id、步数、工具名、耗时与积分，
// 不记消息、工具参数或输出。字段由调用方逐个给出，不接受任意对象，避免把内容误带进日志。

export interface TurnLogInput {
  readonly turnId: string
  readonly conversationId: string
  readonly workspaceId: string
  readonly userId: string
  readonly status: string
  readonly steps: number
  /** 本次调用中出现的工具名（去重） */
  readonly tools: readonly string[]
  readonly durationMs: number
  readonly credits?: number | undefined
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly reused?: boolean | undefined
  readonly errorCode?: string | undefined
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

export function turnLogFields(input: TurnLogInput): Record<string, unknown> {
  return {
    turnId: input.turnId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    status: input.status,
    steps: input.steps,
    // 工具名来自注册表；不合格式的值（理论上不会出现）不写入日志
    tools: [...new Set(input.tools)].filter((name) => TOOL_NAME.test(name)),
    durationMs: input.durationMs,
    ...(input.credits === undefined ? {} : { credits: input.credits }),
    ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    ...(input.reused === undefined ? {} : { reused: input.reused }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  }
}

/** 错误只记 code 与类名，不记 message（可能带模型输出或工具参数） */
export function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) return name
  }
  return 'UNKNOWN'
}
