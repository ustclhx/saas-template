import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

// Nitro 默认 buildDir 下的 Vite SSR service 中间产物；其 map 已指向 TypeScript 并含源码。
const serviceOutput = fileURLToPath(
  new URL('./node_modules/.nitro/vite/services/', import.meta.url),
)

/**
 * Nitro 第二遍 rolldown 把 service 中间 JS 当作普通输入，不读取其 map，
 * 最终 `_ssr/*.mjs.map` 只指向会被丢弃的中间文件。load 时交出中间 map，由 rolldown 串接到源码。
 */
const serviceInputMaps = {
  name: 'saas:service-input-maps',
  async load(id: string) {
    if (!id.startsWith(serviceOutput) || !id.endsWith('.js')) return null
    const map = await readFile(`${id}.map`, 'utf8').catch(() => null)
    if (!map) return null
    return { code: await readFile(id, 'utf8'), map }
  },
}

export default defineConfig({
  // Node 构建不读取部署 dotenv 或数据库，生产校验只在直接启动产物时执行。
  envDir: false,
  build: { sourcemap: 'hidden' },
  define: { __APP_VERSION__: JSON.stringify(version) },
  environments: {
    // SSR service 只打包 web 根解析不到的依赖（如 @saas/ui 引入的 lucide-react 走 node 条件的 CJS 版、
    // use-sync-external-store），react 等根依赖保持外置。默认的 require polyfill 会把这些 CJS 里的
    // require('react') 变成 createRequire 运行时调用，Nitro 第二遍看不到它，另行打包的 react 与运行时
    // 从 node_modules 加载的 react 成为两个实例，SSR 时 hooks dispatcher 为 null。
    // 保留裸 require 交给第二遍 rolldown 解析，使所有引用汇合到同一份 react。
    ssr: { build: { rolldownOptions: { output: { polyfillRequire: false } } } },
  },
  plugins: [
    ogImages(),
    pricingSnapshotPlugin(),
    ...sitePlugins('server.node.ts', 'node'),
    nitro({
      preset: 'node_server',
      sourcemap: true,
      // bootstrap 独立编译，SDK 仍需被 trace 到可复制的生产产物。
      // cf-workers-og 的 Node 入口按 import.meta.url 读取包内 WASM，必须保留包目录结构，不能打进 _libs。
      traceDeps: ['@sentry/node', 'cf-workers-og'],
      entry: fileURLToPath(new URL('./src/node/http.ts', import.meta.url)),
      serverEntry: false,
      // 默认 sourcemapMinify 会删除 sourcesContent，并清空来源全在 node_modules（含上述中间产物）的 mappings。
      experimental: { asyncContext: true, sourcemapMinify: false },
      // workspace 源码必须编译，第三方/原生依赖由 Nitro trace 到独立产物。
      noExternals: [/^@saas\//],
      // B 的 barrel 导出尚未装配，保留外置边界并移除未使用的引擎导入。
      rolldownConfig: {
        plugins: [serviceInputMaps],
        external: ['@dbos-inc/dbos-sdk', 'pg'],
        treeshake: { moduleSideEffects: (id) => !['@dbos-inc/dbos-sdk', 'pg'].includes(id) },
      },
    }),
  ],
})
