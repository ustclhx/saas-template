import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

const webServer = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer
if (process.env.STAGING_URL || process.env.PRODUCTION_URL || !webServer)
  throw new Error('Agents e2e only supports the isolated local server')

export default defineConfig({
  ...base,
  testMatch: 'agents.spec.ts',
  testIgnore: [],
  webServer: {
    ...webServer,
    // 本地 Worker 的结构化日志用于断言停止过程，留在已忽略的目录。
    command:
      'mkdir -p .wrangler && pnpm exec vite dev --config e2e/agents/vite.ts > .wrangler/agents-e2e.log 2>&1',
    reuseExistingServer: false,
    // 全新 worktree 需要首次编译插件、生成文案并启动 workerd。
    timeout: 240_000,
  },
})
