import { log } from '@saas/shared/log'
import { instrumentAgentWithSentry } from '@sentry/cloudflare'
import { sentryEnabled, sentryOptions } from '@web/server/cloudflare/sentry.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { routeAgentRequest } from 'agents'
import { AgentConversation as AgentConversationBase } from './agent.ts'
import { authorizeAgentRequest } from './gate.ts'

export { registerPluginAgentTools } from '../registry.ts'
// agents 插件的 Worker 入口（openspec add-ai-agents 决策 2、12）：具名导出 Durable Object 类，
// default 导出 fetch 前置处理，只接管 `/agents/` 前缀。前置处理运行在 web 的请求运行时中
// （server.ts 的 withWebRuntime），复用站点会话与按请求创建的数据库客户端。
// Durable Object 中的错误上报 Sentry（任务 4.5）：与 web 相同的选项与开关，本地与未配置 DSN 时不启用
export const AgentConversation = instrumentAgentWithSentry(
  (env: Cloudflare.Env) => ({ ...sentryOptions(env), enabled: sentryEnabled(env) }),
  AgentConversationBase,
)

interface AgentsEnv {
  AGENT_CONVERSATION: DurableObjectNamespace<AgentConversationBase>
}

const PREFIX = '/agents/'

const notFound = () => new Response('Not found', { status: 404 })

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response | undefined> {
    if (!new URL(request.url).pathname.startsWith(PREFIX)) return undefined
    const agentsEnv = env as unknown as AgentsEnv
    const runtime = getWebRuntime()
    const authorize = (req: Request, route: { name: string }) =>
      authorizeAgentRequest(req, route.name, { db: runtime.db, auth: runtime.auth })
    // routeAgentRequest 会把 env 中所有 Durable Object 绑定按 kebab-case 名暴露为 /agents/<binding>/…，
    // 只传入本插件的绑定，避免其他 Durable Object 被路由到。两个钩子都必须校验：SDK 自带的
    // HTTP 端点（如 get-messages）走 onBeforeRequest，WebSocket 连接走 onBeforeConnect。
    const response = await routeAgentRequest(
      request,
      { AGENT_CONVERSATION: agentsEnv.AGENT_CONVERSATION },
      { onBeforeConnect: authorize, onBeforeRequest: authorize },
    )
    if (response) return response
    log.warn('agents.route.miss', { path: new URL(request.url).pathname })
    return notFound()
  },
}
