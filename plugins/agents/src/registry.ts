import type { AgentToolContribution, RegisteredAgentTool } from '@saas/ai'
import { AppError } from '@saas/shared'
import type { ToolSet } from 'ai'
import { projectAgents } from './agents.project.ts'
import type { AgentDefinition } from './definition.ts'
import { exampleTools } from './example-tools.ts'
import type { AgentExecutionContext, AgentToolResolutionContext } from './tool-context.ts'
import { projectTools } from './tools.project.ts'

type RegisteredTool = RegisteredAgentTool<AgentExecutionContext>
type ToolSource = { readonly id: string; readonly tools: readonly RegisteredTool[] }

export function createAgentRegistry(
  definitions: readonly AgentDefinition[],
  sources: readonly ToolSource[],
) {
  const registered = new Map<string, { tool: RegisteredTool; sourceId: string }>()
  for (const { id, tools } of sources) {
    for (const tool of tools) {
      const existing = registered.get(tool.name)
      if (existing) {
        throw new Error(`Duplicate agent tool "${tool.name}" from ${existing.sourceId} and ${id}`)
      }
      registered.set(tool.name, { tool, sourceId: id })
    }
  }

  const agents = new Map<string, readonly RegisteredTool[]>()
  for (const agent of definitions) {
    if (agents.has(agent.id)) throw new Error(`Duplicate agent "${agent.id}"`)
    const tools = agent.tools.map((name) => {
      const registration = registered.get(name)
      if (!registration) throw new Error(`Agent "${agent.id}" uses unknown tool "${name}"`)
      return registration.tool
    })
    for (const name of agent.optionalTools ?? []) {
      const registration = registered.get(name)
      if (registration && !agent.tools.includes(name)) tools.push(registration.tool)
    }
    agents.set(agent.id, tools)
  }

  return {
    resolveAgentTools(agentId: string, ctx: AgentToolResolutionContext): ToolSet {
      const allowedTools = agents.get(agentId)
      if (!allowedTools) throw new AppError('NOT_FOUND', 'Agent not found', { status: 404 })

      const { turnId, ...context } = ctx
      const tools: ToolSet = Object.create(null)
      for (const tool of allowedTools) {
        tools[tool.name] = tool.bind(({ toolCallId, abortSignal }) => ({
          ...context,
          idempotencyKey: `${turnId}:${toolCallId}`,
          signal: abortSignal ?? context.signal,
        }))
      }
      return tools
    },
  }
}

const localSources = [
  { id: 'agents examples', tools: exampleTools },
  { id: 'tools.project.ts', tools: projectTools },
]

// Worker 启动时只登记定义。数据库、身份和轮次仍由每次解析工具的调用方提供。
let registry: ReturnType<typeof createAgentRegistry> | undefined

export function registerPluginAgentTools(
  plugins: readonly {
    readonly id: string
    readonly entry: {
      readonly agentTools?: AgentToolContribution<AgentExecutionContext>
      readonly default: unknown
    }
  }[],
): void {
  registry = createAgentRegistry(projectAgents, [
    ...localSources,
    ...plugins.map(({ id, entry: { agentTools } }) => ({
      id: `plugin ${id}`,
      tools: typeof agentTools === 'function' ? agentTools() : (agentTools ?? []),
    })),
  ])
}

export function listAgents(): readonly AgentDefinition[] {
  return projectAgents
}

export function getAgent(id: string): AgentDefinition | undefined {
  return listAgents().find((agent) => agent.id === id)
}

export function resolveAgentTools(agentId: string, ctx: AgentToolResolutionContext): ToolSet {
  registry ??= createAgentRegistry(projectAgents, localSources)
  return registry.resolveAgentTools(agentId, ctx)
}
