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
  /** 可选工具：仅在提供它的插件启用时加入（如媒体插件的 generate_image），未注册时跳过而不报错 */
  readonly optionalTools?: readonly string[]
  readonly maxSteps?: number
}

export function defineAgent<const Definition extends AgentDefinition>(
  definition: Definition,
): Definition {
  return definition
}
