import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, type Plugin } from 'vite'
import templateConfig from '../../../../template.config.ts'
import { sitePlugins } from '../../scripts/vite-shared.ts'

const root = new URL('../../../../', import.meta.url)
const worktree = parseEnv(readFileSync(new URL('.env.worktree', root), 'utf8'))
const database = new URL(worktree.DATABASE_URL ?? 'http://missing')
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
  !/^\/saas_wt_[a-zA-Z0-9_-]+$/.test(database.pathname)
)
  throw new Error('Local fault Vite requires an isolated loopback database')
for (const binding of ['HYPERDRIVE', 'HYPERDRIVE_CACHED'])
  process.env[`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`] = database.toString()
const runtimeHelper = new URL('./fault-local-runtime.ts', import.meta.url).pathname
const mediaHelper = new URL('./fault-local-media.ts', import.meta.url).pathname
const mediaEnabled = Boolean(templateConfig.plugins.media)
function replaceOnce(code: string, needle: string, replacement: string) {
  if (code.split(needle).length !== 2) throw new Error(`Local fault transform mismatch: ${needle}`)
  return code.replace(needle, replacement)
}
const fixture: Plugin = {
  name: 'fault-acceptance-local-only',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './model.ts' && importer?.endsWith('/packages/ai/src/text/index.ts'))
      return new URL('./local-text-model.ts', import.meta.url).pathname
  },
  transform(code, id) {
    if (this.environment.name !== 'ssr') return
    if (id.endsWith('/src/server/runtime.ts')) {
      const mediaImport = mediaEnabled
        ? `import { localMediaAi } from ${JSON.stringify(mediaHelper)}\n`
        : ''
      const runtime = mediaEnabled
        ? 'localWebRuntime(runtime, localMediaAi)'
        : 'localWebRuntime(runtime)'
      return `import { localWebRuntime } from ${JSON.stringify(runtimeHelper)}\n${mediaImport}${replaceOnce(code, '  return runtime\n}', `  return ${runtime}\n}`)}`
    }
    // 启动校验与 Sentry 包装读取的 bindings 也清空，.dev.vars 无法恢复真实外部凭据。
    if (id.endsWith('/src/server.ts')) {
      const entry = 'export default {\n  fetch(request, env, ctx) {'
      return `import { localBindings } from ${JSON.stringify(runtimeHelper)}\n${replaceOnce(code, entry, `${entry}\n    env = localBindings(env)`)}`
    }

    if (!mediaEnabled) return
    if (id.endsWith('/src/features/ai/runtime.ts')) {
      const original = replaceOnce(
        code,
        'export function getAiHttpDeps()',
        'function realAiHttpDeps()',
      )
      return `import { localHttpDeps } from ${JSON.stringify(mediaHelper)}\n${original}\nexport function getAiHttpDeps() { return localHttpDeps(realAiHttpDeps()) }`
    }
    if (id.endsWith('/src/routes/api/files/$id.ts'))
      return replaceOnce(
        code,
        "import { handleFileDownload } from '../../../features/files/http.ts'",
        `import { localDownload as handleFileDownload } from ${JSON.stringify(new URL('./local-media.ts', import.meta.url).pathname)}`,
      )
  },
}
const version = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim()
export default defineConfig({
  server: { port: Number(worktree.WEB_PORT ?? 3000), strictPort: true },
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    fixture,
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      remoteBindings: false,
      inspectorPort: Number(worktree.WEB_INSPECTOR_PORT ?? 9229),
      config: {
        vars: {
          APP_URL: process.env.STAGING_URL ?? `http://localhost:${worktree.WEB_PORT ?? 3000}`,
          SENTRY_ENVIRONMENT: 'staging',
          AI_FAULT_INJECTION: 'enabled',
          SENTRY_DSN: '',
          LOCAL_WORKFLOW_START_DELAY_MS: process.env.LOCAL_WORKFLOW_START_DELAY_MS ?? '0',
        },
      },
    }),
    ...sitePlugins(),
  ],
})
