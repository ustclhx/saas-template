import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { ogImages } from './scripts/og-images.ts'
import { pricingSnapshotPlugin } from './scripts/pricing-snapshot.ts'
import { sitePlugins } from './scripts/vite-shared.ts'

const version =
  process.env.APP_VERSION ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('APP_VERSION must be a full git SHA')

export default defineConfig({
  // Node 构建不读取部署 dotenv 或数据库，生产校验只在直接启动产物时执行。
  envDir: false,
  build: { sourcemap: 'hidden' },
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    ogImages(),
    pricingSnapshotPlugin(),
    ...sitePlugins('server.node.ts'),
    nitro({
      preset: 'node_server',
      sourcemap: true,
      // bootstrap 独立编译，SDK 仍需被 trace 到可复制的生产产物。
      traceDeps: ['@sentry/node'],
      entry: fileURLToPath(new URL('./src/node/http.ts', import.meta.url)),
      serverEntry: false,
      experimental: { asyncContext: true },
      // workspace 源码必须编译，第三方/原生依赖由 Nitro trace 到独立产物。
      noExternals: [/^@saas\//],
      // B 的 barrel 导出尚未装配，保留外置边界并移除未使用的引擎导入。
      rolldownConfig: {
        external: ['@dbos-inc/dbos-sdk', 'pg'],
        treeshake: { moduleSideEffects: (id) => !['@dbos-inc/dbos-sdk', 'pg'].includes(id) },
      },
    }),
  ],
})
