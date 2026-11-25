import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, loadEnv } from 'vite'
import { syncLocalPaymentEnv } from '../../scripts/local-payment-env.mjs'
import templateConfig from '../../template.config.ts'
import { marketingPerformanceOptions } from './scripts/client-template-config.ts'
import { ogImages } from './scripts/og-images.ts'
import { prerenderEnvFallback } from './scripts/prerender-env.ts'
import { pricingSnapshotPlugin } from './scripts/pricing-snapshot.ts'
import { sitePlugins } from './scripts/vite-shared.ts'

const repoRoot = new URL('../../', import.meta.url).pathname
const performanceOptionsFile = fileURLToPath(
  new URL('./dist/.build/marketing-performance.json', import.meta.url),
)
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}
const appVersion = (() => {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || pkg.version
    )
  } catch {
    // 源码归档或无 git 的构建环境仍可构建，包版本作为最后回退。
    return pkg.version
  }
})()

// 部署流水线先运行 `pnpm deploy:resources` 写出已填好资源 ID 的 wrangler.deploy.json，
// 再经此变量让 Cloudflare 插件读取它（add-deploy-autoprovision 决策 4）；相对路径按 apps/web 解析。
// 未设置时沿用插件默认查找的 wrangler.jsonc，本地开发与 CI 构建不变。
const deployConfigPath = process.env.WRANGLER_DEPLOY_CONFIG
  ? resolve(fileURLToPath(new URL('./', import.meta.url)), process.env.WRANGLER_DEPLOY_CONFIG)
  : undefined

// Orca worktree 的端口写在仓库根目录的 .env.worktree（docs/09-parallel-plan.md §2）；
// 文件不存在时（主 checkout）使用默认端口。
const worktreeEnv = loadEnv('worktree', repoRoot, '')
const port = Number(worktreeEnv.WEB_PORT ?? 3000)
const inspectorPort = Number(worktreeEnv.WEB_INSPECTOR_PORT ?? 9229)

// Hyperdrive 本地连接：wrangler 优先读取这两个环境变量，其次是 wrangler.jsonc 中的 localConnectionString。
for (const binding of ['HYPERDRIVE', 'HYPERDRIVE_CACHED']) {
  const name = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`
  const value = worktreeEnv[name]
  if (value && !process.env[name]) process.env[name] = value
}

export default defineConfig(({ command }) => {
  // 本地 dev 时把根目录 .env.local 的五项测试支付配置同步到 .dev.vars 管理区块（#26）
  if (command === 'serve') syncLocalPaymentEnv(new URL('./', import.meta.url))
  const adminMcpLimit = templateConfig.plugins['admin-mcp']?.rateLimitPerMinute
  return {
    build: {
      sourcemap: 'hidden',
      // 关闭模块预加载：首屏 HTML 会带上全部路由 chunk 的 modulepreload，与阻塞首绘的样式表争抢带宽，
      // 首绘与 LCP 被推迟；水合所需的模块仍由入口的 import 链加载。
      modulePreload: false,
    },
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [
      ogImages(),
      // SSR 由 workerd 执行：Cloudflare 插件接管 Vite 的 ssr 环境
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        ...(deployConfigPath ? { configPath: deployConfigPath } : {}),
        // Workers AI 无本地模拟；开发与预览禁用远程绑定，避免启动时要求登录或真实推理。
        remoteBindings: false,
        inspectorPort,
        config: (config) => {
          // 本地开发时 Better Auth 的 baseURL 跟随 worktree 端口。
          if (command === 'serve' || process.env.APP_URL) {
            config.vars.APP_URL = process.env.APP_URL ?? `http://localhost:${port}`
            // smoke e2e 设为 false，断言未开启时 /dev/ui 返回 404。
            if (process.env.UI_PREVIEW !== undefined)
              config.vars.UI_PREVIEW = process.env.UI_PREVIEW
          }
          // 原地更新生效环境的绑定，避免 Vite 插件合并数组时追加重复绑定。
          const adminMcpBinding = config.ratelimits.find(({ name }) => name === 'RL_ADMIN_MCP')
          if (adminMcpBinding && typeof adminMcpLimit === 'number')
            adminMcpBinding.simple.limit = adminMcpLimit
        },
      }),
      // 没有 .dev.vars 时（CI）预渲染用的 preview 改用 .dev.vars.example 的假值通过启动校验
      prerenderEnvFallback(),
      pricingSnapshotPlugin(
        process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED,
      ),
      marketingPerformanceOptions(performanceOptionsFile, {
        ...templateConfig.marketing.performance,
        prerender: templateConfig.marketing.enabled,
      }),
      ...sitePlugins(),
    ],
  }
})
