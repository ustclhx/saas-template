import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import templateConfig from '../../../../template.config.ts'
import appConfig from '../../vite.config.ts'

const localPath = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const depsModule = '\0agents-e2e-deps'

// 只在本地验收入口注入模型与项目工具，保留真实 Worker、实例、鉴权、确认和计费。
const fixtures: Plugin = {
  name: 'agents-e2e-fixtures',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer?.endsWith('/plugins/agents/src/worker/agent.ts') && source === './deps.ts')
      return depsModule
    if (
      importer?.endsWith('/plugins/agents/src/registry.ts') &&
      (source === './agents.project.ts' || source === './tools.project.ts')
    )
      return localPath('./project.ts')
  },
  load(id) {
    // 注册与会话仍走真实 Better Auth，本地套件关闭外部人机验证。
    if (id === localPath('../../../../template.config.ts'))
      return `export default ${JSON.stringify({
        ...templateConfig,
        auth: { ...templateConfig.auth, turnstile: false },
      })}`
    if (id !== depsModule) return
    return `
      import { createAgentTurnDeps as realDeps } from ${JSON.stringify(localPath('../../../../plugins/agents/src/worker/deps.ts'))}
      import { model } from ${JSON.stringify(localPath('./model.ts'))}
      export const createAgentTurnDeps = (env, captureError) => ({
        ...realDeps(env, captureError),
        languageModel: () => model,
      })
    `
  },
}

export default defineConfig(async (env) => {
  if (env.command !== 'serve' || process.env.CLOUDFLARE_ENV)
    throw new Error('Agents e2e only supports Vite dev with local bindings')
  const config = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return {
    ...config,
    plugins: [fixtures, ...(config.plugins ?? [])],
    environments: {
      ssr: {
        // 首次整页刷新前预打包惰性依赖，避免 workerd 在 SSR 过程中重启。
        optimizeDeps: {
          include: [
            'better-auth/client',
            'better-auth/client/plugins',
            '@saas/plugin-agents > @cloudflare/ai-chat/react',
            '@saas/plugin-agents > agents/react',
            '@ai-sdk/react',
            '@saas/ui > react-markdown',
            '@saas/ui > remark-gfm',
            '@saas/ui > remark-parse',
            '@saas/ui > unified',
          ],
        },
      },
    },
  }
})
