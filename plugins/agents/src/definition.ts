import type { AgentExecutionContext } from './tool-context.ts'

export interface AgentDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: (
    ctx: Pick<AgentExecutionContext, 'workspaceId' | 'userId' | 'conversationId'>,
  ) => string
  readonly defaultModel?: string
  readonly tools: readonly string[]
  readonly maxSteps?: number
}

export function defineAgent<const Definition extends AgentDefinition>(
  definition: Definition,
): Definition {
  return definition
}
