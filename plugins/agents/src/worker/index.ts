import { log } from '@saas/shared/log'
import { routeAgentRequest } from 'agents'
import type { AgentConversation } from './agent.ts'

export { registerPluginAgentTools } from '../registry.ts'
// agents 插件的 Worker 入口（openspec add-ai-agents 决策 2、12）：具名导出 Durable Object 类，
// default 导出 fetch 前置处理，只接管 `/agents/` 前缀。
export { AgentConversation } from './agent.ts'

interface AgentsEnv {
  AGENT_CONVERSATION: DurableObjectNamespace<AgentConversation>
  SENTRY_ENVIRONMENT?: string
}

const PREFIX = '/agents/'

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response | undefined> {
    if (!new URL(request.url).pathname.startsWith(PREFIX)) return undefined
    const agentsEnv = env as unknown as AgentsEnv
    // TODO(3.1)：剥离 x-saas-* → 会话校验（401）→ 对话归属与成员资格（404）→ 写入身份头。
    // 在此之前只在本地开发开放，其他环境一律 404。
    if (agentsEnv.SENTRY_ENVIRONMENT !== 'development')
      return new Response('Not found', { status: 404 })
    // routeAgentRequest 会把 env 中所有 Durable Object 绑定按 kebab-case 名暴露为 /agents/<binding>/…，
    // 只传入本插件的绑定，避免其他 Durable Object 被路由到
    const response = await routeAgentRequest(request, {
      AGENT_CONVERSATION: agentsEnv.AGENT_CONVERSATION,
    })
    if (response) return response
    log.warn('agents.route.miss', { path: new URL(request.url).pathname })
    return new Response('Not found', { status: 404 })
  },
}
