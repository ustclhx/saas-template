import { definePlugin } from '@saas/config'
import { agentsConfigSchema } from './src/config.ts'

// agents 插件清单（openspec add-ai-agents）：每个对话一个 Durable Object（AIChatAgent），类由 web Worker 导出。
// 实例操作只在 web 内发生；jobs 不绑定该类：web 已经按 script_name 绑定 jobs 的 Workflow，
// 反向再绑定会让两个 Worker 互相依赖，新项目首次部署在任何顺序下都可能失败（决策 12）。仅 Cloudflare 目标。
export default definePlugin({
  id: 'agents',
  targets: ['cloudflare'],
  requires: { features: ['billing', 'credits'] },
  routes: { dir: 'routes', mount: '' },
  entries: { web: 'src/web/web.ts', worker: 'src/worker/index.ts', jobs: 'src/jobs/index.ts' },
  bindings: {
    web: [{ name: 'AGENT_CONVERSATION', kind: 'durable_object', className: 'AgentConversation' }],
  },
  messages: 'messages',
  config: agentsConfigSchema,
})
