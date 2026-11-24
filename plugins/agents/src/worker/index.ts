import { env as workerEnv } from 'cloudflare:workers'
import { registerDeletionStep } from '@saas/auth'
import { log } from '@saas/shared/log'
import { instrumentAgentWithSentry } from '@sentry/cloudflare'
import { sentryEnabled, sentryOptions } from '@web/server/cloudflare/sentry.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { routeAgentRequest } from 'agents'
import { createAgentDeletionStep } from '../core/deletion.ts'
import { agentInstanceCleaner, setAgentInstanceCleaner } from '../instances.ts'
import { registerPluginAgentTools as registerAgentTools } from '../registry.ts'
import { AgentConversation as AgentConversationBase } from './agent.ts'
import { authorizeAgentRequest } from './gate.ts'
import { registerWorkerPlugins } from './services.ts'

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

/**
 * 由 plugins.worker.gen.ts 在 Worker 启动时调用一次：汇总插件工具，并登记 Worker 插件注册表
 * （工具 services 中的 AI 任务工作流取自其中，见 services.ts）。
 */
export function registerPluginAgentTools(
  tools: Parameters<typeof registerAgentTools>[0],
  workerPlugins: Parameters<typeof registerWorkerPlugins>[0] = [],
): void {
  registerAgentTools(tools)
  registerWorkerPlugins(workerPlugins)
}

// 实例清理只在 web 内经 Durable Object 绑定发起（决策 7、12）：删除对话与删号 / 删空间共用。
// 绑定缺失（未部署）时不登记，实例由自己的 alarm 自清理。
const namespace = (workerEnv as unknown as Partial<AgentsEnv>).AGENT_CONVERSATION
if (namespace)
  setAgentInstanceCleaner((conversationId) => namespace.getByName(conversationId).requestPurge())
// 删号 / 删空间（7.2）：删除事务中删轮次与对话行，提交后清理实例
registerDeletionStep('account', createAgentDeletionStep('account', agentInstanceCleaner))
registerDeletionStep('workspace', createAgentDeletionStep('workspace', agentInstanceCleaner))

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
