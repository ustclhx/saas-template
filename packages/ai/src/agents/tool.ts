import type { Tool } from 'ai'
import type { z } from 'zod'

type ToolLog = Record<
  'info' | 'warn' | 'error',
  (event: string, fields?: Readonly<Record<string, unknown>>) => void
>

export interface AgentToolContext<Db = unknown, Services = unknown> {
  readonly workspaceId: string
  readonly userId: string
  readonly conversationId: string
  /** 由调用方按轮次 ID 与工具调用 ID 生成，重放时用于副作用去重。 */
  readonly idempotencyKey: string
  readonly signal: AbortSignal | undefined
  readonly log: ToolLog
  readonly db: Db
  readonly services: Services
}

export interface AgentTool<Schema extends z.ZodType, Output, Context extends AgentToolContext> {
  readonly name: string
  readonly description: string
  readonly input: Schema
  readonly needsApproval?: boolean | ((input: z.output<Schema>) => boolean)
  readonly execute: (input: z.output<Schema>, ctx: Context) => Promise<Output>
}

type ToolCall = { toolCallId: string; abortSignal?: AbortSignal | undefined }

/** 异构注册表通过绑定函数保留具体工具的 schema 与输入类型。 */
export interface RegisteredAgentTool<Context extends AgentToolContext> {
  readonly name: string
  readonly bind: (createContext: (call: ToolCall) => Context) => Tool
}

export type AgentToolContribution<Context extends AgentToolContext> =
  | readonly RegisteredAgentTool<Context>[]
  | (() => readonly RegisteredAgentTool<Context>[])

export function defineAgentTool<Schema extends z.ZodType, Output, Context extends AgentToolContext>(
  definition: AgentTool<Schema, Output, Context>,
): AgentTool<Schema, Output, Context> & RegisteredAgentTool<Context> {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(definition.name)) {
    throw new Error(`Invalid agent tool name "${definition.name}": expected snake_case`)
  }
  return {
    ...definition,
    bind: (createContext) => toAiSdkTool(definition, createContext),
  }
}

export function toAiSdkTool<Schema extends z.ZodType, Output, Context extends AgentToolContext>(
  definition: AgentTool<Schema, Output, Context>,
  createContext: (call: ToolCall) => Context,
) {
  return {
    description: definition.description,
    inputSchema: definition.input,
    needsApproval: definition.needsApproval ?? false,
    execute: (input: z.output<Schema>, { toolCallId, abortSignal }: ToolCall) =>
      definition.execute(input, createContext({ toolCallId, abortSignal })),
  } satisfies Tool
}

/**
 * 长任务工具的「已提交」结果（openspec add-ai-agents 决策 8）：工具提交任务后立即返回，
 * 对话实例按 taskId 拉取任务状态，终态时把同一工具调用的输出改写为最终结果。
 */
export interface AgentPendingTaskOutput {
  readonly taskId: string
  readonly status: 'pending'
  readonly kind?: string | undefined
}

export function pendingTaskOutput(taskId: string, kind?: string): AgentPendingTaskOutput {
  return kind === undefined ? { taskId, status: 'pending' } : { taskId, status: 'pending', kind }
}

export function isPendingTaskOutput(value: unknown): value is AgentPendingTaskOutput {
  if (typeof value !== 'object' || value === null) return false
  const output = value as Record<string, unknown>
  return output.status === 'pending' && typeof output.taskId === 'string' && output.taskId !== ''
}
