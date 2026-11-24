import { m } from '@web/paraglide/messages.js'
import { agentsWebConfig } from './config.ts'

/**
 * 新建对话可选的 agent（openspec add-ai-agents 决策 4「Agent 定义」）：页面与服务端函数只读这份可序列化的摘要。
 * TODO(5.1/5.2)：工具注册汇总与 `agents.project.ts` 合并后改为读取其 `listAgents()`（id、名称、说明、工具名）；
 * 在此之前用配置段的 `defaultAgent` 兜底，只提供一个 agent，工具列表为空。
 */
export interface AgentOption {
  readonly id: string
  readonly name: string
  readonly description: string
  /** agent 定义列出的工具名（空状态与新建弹窗中展示） */
  readonly tools: readonly string[]
  /** 空对话中的示例任务（点击即发送） */
  readonly suggestions: readonly string[]
}

/** 当前项目可选的 agent，第一项为默认 agent；名称与说明按请求语言取文案 */
export function listAgentOptions(): AgentOption[] {
  return [
    {
      id: agentsWebConfig.defaultAgent,
      name: m.agents_default_agent_name(),
      description: m.agents_default_agent_description(),
      tools: [],
      suggestions: [m.agents_default_agent_suggestion_1(), m.agents_default_agent_suggestion_2()],
    },
  ]
}

export function findAgentOption(id: string): AgentOption | undefined {
  return listAgentOptions().find((agent) => agent.id === id)
}
