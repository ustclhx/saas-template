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
    command: 'pnpm exec vite dev --config e2e/agents/vite.ts',
    reuseExistingServer: false,
    // 全新 worktree 需要首次编译插件、生成文案并启动 workerd。
    timeout: 240_000,
  },
})
