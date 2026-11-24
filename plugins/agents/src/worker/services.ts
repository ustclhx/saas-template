import type { Capability, Workflow } from '@saas/platform'
import { createCloudflareRateLimiter } from '@saas/platform/cloudflare'
import type { AgentToolServices } from '../tool-context.ts'

// 工具 services 的装配（openspec add-ai-agents 决策 4、8）：实例不在 web 的请求运行时中，
// 按 Worker 绑定创建与 web 运行时同源的依赖。Worker 插件注册表在启动时由生成文件登记一次，
// 只含模块定义、不含租户状态（决策 11）。

type AiWorkflow = Capability<Workflow<{ taskId: string }>>

interface WorkerPluginEntry {
  readonly entry?: { readonly createAiWorkflow?: (env: Cloudflare.Env) => AiWorkflow }
}

let workerPlugins: readonly WorkerPluginEntry[] = []

export function registerWorkerPlugins(plugins: readonly WorkerPluginEntry[]): void {
  workerPlugins = plugins
}

/** 与 web 运行时的 createPluginAiWorkflow 相同：取第一个可用的插件工作流 */
function pluginAiWorkflow(env: Cloudflare.Env): AiWorkflow {
  for (const { entry } of workerPlugins) {
    const workflow = entry?.createAiWorkflow?.(env)
    if (workflow?.available) return workflow
  }
  return { available: false }
}

export function createToolServices(env: Cloudflare.Env): AgentToolServices {
  return {
    env: env as unknown as Readonly<Record<string, unknown>>,
    aiWorkflow: pluginAiWorkflow(env),
    rateLimiter: createCloudflareRateLimiter(env),
  }
}
