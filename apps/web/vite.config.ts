import { readFileSync } from 'node:fs'
import { cloudflare } from '@cloudflare/vite-plugin'
import contentCollections from '@content-collections/vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import templateConfig from '../../template.config.ts'
import { i18nMessages } from './scripts/i18n-project.ts'
import { prerenderEnvFallback } from './scripts/prerender-env.ts'
import { pricingSnapshotPlugin } from './scripts/pricing-snapshot.ts'
import { APP_AREA_PREFIXES } from './src/features/i18n/app-area.ts'
import { isPrerenderedPath, prerenderEntryPages } from './src/features/marketing/prerender.ts'

const repoRoot = new URL('../../', import.meta.url).pathname
const { i18n } = templateConfig
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

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

export default defineConfig(({ command }) => ({
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    // SSR 由 workerd 执行：Cloudflare 插件接管 Vite 的 ssr 环境
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      inspectorPort,
      // 本地开发时 Better Auth 的 baseURL 跟随实际端口（worktree 各不相同）；构建产物沿用 wrangler.jsonc
      ...(command === 'serve' && { config: { vars: { APP_URL: `http://localhost:${port}` } } }),
    }),
    // 没有 .dev.vars 时（CI）预渲染用的 preview 改用 .dev.vars.example 的假值通过启动校验
    prerenderEnvFallback(),
    pricingSnapshotPlugin(
      process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED,
    ),
    tailwindcss(),
    // 编译 messages/ 下的文案到 src/paraglide（已 gitignore），语言列表取自模板配置
    i18nMessages({ i18n, appAreaPrefixes: APP_AREA_PREFIXES }),
    // content/ 下的博客、法律页与文档（content-collections.ts），生成 `content-collections` 别名指向的数据
    contentCollections(),
    // 营销页、博客、法律页与文档预渲染（design.md 决策 2）：从各语言首页爬取链接，只保留 prerender.ts 列出的路径。
    // 输出 `<path>.html`（而不是 `<path>/index.html`），静态资源按无末尾 `/` 的地址提供，与路由器一致
    tanstackStart({
      pages: prerenderEntryPages(i18n.locales, i18n.defaultLocale),
      prerender: {
        enabled: true,
        crawlLinks: true,
        autoStaticPathsDiscovery: false,
        autoSubfolderIndex: false,
        filter: (page) => isPrerenderedPath(page.path, i18n.locales),
      },
    }),
    viteReact(),
  ],
}))
