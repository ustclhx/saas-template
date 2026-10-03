import { readFileSync } from 'node:fs'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const repoRoot = new URL('../../', import.meta.url).pathname
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

export default defineConfig({
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    // SSR 由 workerd 执行：Cloudflare 插件接管 Vite 的 ssr 环境
    cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort }),
    tanstackStart(),
    viteReact(),
  ],
})
