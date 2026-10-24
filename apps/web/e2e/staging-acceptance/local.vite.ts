import { defineConfig, type Plugin } from 'vite'
import appConfig from '../../vite.config.ts'

const helper = new URL('./local-media.ts', import.meta.url).pathname
function replaceOnce(code: string, needle: string, replacement: string) {
  if (code.split(needle).length !== 2) throw new Error(`Local transform mismatch: ${needle}`)
  return code.replace(needle, replacement)
}
const mocks: Plugin = {
  name: 'acceptance-local-only',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './model.ts' && importer?.endsWith('/packages/ai/src/text/index.ts'))
      return new URL('./local-text-model.ts', import.meta.url).pathname
  },
  transform(code, id) {
    if (this.environment.name !== 'ssr') return
    // 媒体路由经 getAiHttpDeps 组装 workflow 与 Provider；在此换上本地夹具，匹配不到时直接报错而非让任务停在 queued。
    if (id.endsWith('/src/features/ai/runtime.ts')) {
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
    }
    if (id.endsWith('/src/routes/api/files/$id.ts'))
      return replaceOnce(
        code,
        "import { handleFileDownload } from '../../../features/files/http.ts'",
        `import { localDownload as handleFileDownload } from ${JSON.stringify(helper)}`,
      )
  },
}
export default defineConfig(async (env) => {
  const config = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return { ...config, plugins: [mocks, ...(config.plugins ?? [])] }
})
