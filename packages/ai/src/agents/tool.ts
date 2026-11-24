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

export function defineAgentTool<Schema extends z.ZodType, Output, Context extends AgentToolContext>(
  definition: AgentTool<Schema, Output, Context>,
): AgentTool<Schema, Output, Context> {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(definition.name)) {
    throw new Error(`Invalid agent tool name "${definition.name}": expected snake_case`)
  }
  return definition
}

type ToolCall = { toolCallId: string; abortSignal?: AbortSignal | undefined }

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
