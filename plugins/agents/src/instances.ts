import type { AgentInstanceCleaner } from './core/lifecycle.ts'

// 实例清理入口（openspec add-ai-agents 决策 7、12）：web 内的 Durable Object 绑定只在 Worker 入口可用，
// 由 worker/index.ts 在 Worker 启动时登记；删除对话的服务端函数与删号步骤经这里调用。
// 只保存函数本身，不含租户状态（决策 11）。未登记（如测试、未部署绑定）时实例由 alarm 自清理。
let cleaner: AgentInstanceCleaner | undefined

export function setAgentInstanceCleaner(next: AgentInstanceCleaner | undefined): void {
  cleaner = next
}

export function agentInstanceCleaner(): AgentInstanceCleaner | undefined {
  return cleaner
}
