import type { AgentDefinition } from '../definition.ts'
import { getAgent, listAgents } from '../registry.ts'
import { agentsWebConfig } from './config.ts'

/**
 * 新建对话可选的 agent（openspec add-ai-agents 决策 4「Agent 定义」）：页面与服务端函数只读这份可序列化的摘要，
 * 来源为 `agents.project.ts` 经注册表的 `listAgents()` / `getAgent()`（不下发系统提示词）。
 */
export interface AgentOption {
  readonly id: string
  readonly name: string
  readonly description: string
  /** agent 定义列出的工具名（空状态与新建弹窗中展示） */
  readonly tools: readonly string[]
  /** 空对话中的示例任务（点击即发送）；定义可选声明 `suggestions` */
  readonly suggestions: readonly string[]
}

function toOption(agent: AgentDefinition): AgentOption {
  const suggestions = (agent as { readonly suggestions?: readonly string[] }).suggestions
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    tools: [...agent.tools],
    suggestions: suggestions ? [...suggestions] : [],
  }
}

/** 当前项目可选的 agent；配置段 `defaultAgent` 排在第一项（新建弹窗的默认选择），其余按定义顺序 */
export function listAgentOptions(): AgentOption[] {
  const options = listAgents().map(toOption)
  const index = options.findIndex((agent) => agent.id === agentsWebConfig.defaultAgent)
  return index > 0
    ? [options[index] as AgentOption, ...options.filter((_, i) => i !== index)]
    : options
}

export function findAgentOption(id: string): AgentOption | undefined {
  const agent = getAgent(id)
  return agent ? toOption(agent) : undefined
}
