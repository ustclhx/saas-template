import { defineConfig, type Plugin } from 'vite'
import localConfig from './local.vite.ts'

// local.vite.ts 的媒体替换仍针对旧版 /api/ai/tasks 路由（现已改为经 getAiHttpDeps 组装 workflow），
// 匹配不到时任务会一直停在 queued。这里只为 harden 验收在 AI 依赖组装处换上同一组本地夹具，
// 不改共享的 local.vite.ts，其文本模型与下载替换照常生效。
const helper = new URL('./local-media.ts', import.meta.url).pathname
function replaceOnce(code: string, needle: string, replacement: string) {
  if (code.split(needle).length !== 2) throw new Error(`Harden local transform mismatch: ${needle}`)
  return code.replace(needle, replacement)
}
const media: Plugin = {
  name: 'harden-acceptance-local-media',
  enforce: 'pre',
  transform(code, id) {
    if (this.environment.name !== 'ssr' || !id.endsWith('/src/features/ai/runtime.ts')) return
    const original = replaceOnce(
      code,
      'export function getAiHttpDeps()',
      'function realAiHttpDeps()',
    )
    return `import { env as localEnv } from 'cloudflare:workers'
import { localProvider, localWorkflow } from ${JSON.stringify(helper)}
${original}
export function getAiHttpDeps() {
  const real = realAiHttpDeps()
  return {
    ...real,
    env: { ...real.env, MEDIA_WEBHOOK_SECRET: 'local-fixture' },
    workflow: { available: true as const, value: localWorkflow(real.db, localEnv.FILES) as never },
    providerFactory: localProvider,
  }
}`
  },
}
export default defineConfig(async (env) => {
  const config = typeof localConfig === 'function' ? await localConfig(env) : await localConfig
  return { ...config, plugins: [media, ...(config.plugins ?? [])] }
})
