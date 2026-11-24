import { definePlugin } from '@saas/config'
import { agentsConfigSchema } from './src/config.ts'

// agents 插件清单（openspec add-ai-agents）：每个对话一个 Durable Object（AIChatAgent），类由 web Worker 导出；
// jobs 经带 script_name 的 Durable Object 绑定调用实例（删除清理、异步结果写回）。仅 Cloudflare 目标。
export default definePlugin({
  id: 'agents',
  targets: ['cloudflare'],
  requires: { features: ['billing', 'credits'] },
  entries: { worker: 'src/worker/index.ts' },
  bindings: {
    web: [{ name: 'AGENT_CONVERSATION', kind: 'durable_object', className: 'AgentConversation' }],
    jobs: [{ name: 'AGENT_CONVERSATION', kind: 'durable_object', className: 'AgentConversation' }],
  },
  config: agentsConfigSchema,
})
