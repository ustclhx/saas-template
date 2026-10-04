import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'

// 认证页面的 e2e（tasks.md 7.2）：在本地 `vite dev`（web）上运行；默认注册无需邮件消费者，
// 端口取自 Orca worktree 的 .env.worktree（docs/09-parallel-plan.md §2），不存在时用默认端口。
// 已在运行的 dev 进程直接复用；否则由 Playwright 启动，结束后只停止它自己启动的进程。
const repoRoot = new URL('../../', import.meta.url).pathname
const worktreeEnv = loadEnv('worktree', repoRoot, '')
const webPort = Number(worktreeEnv.WEB_PORT ?? 3000)
const authLogPath = process.env.E2E_AUTH_LOG ?? '/tmp/p1-phase-e2e-auth.log'
const quotedAuthLogPath = `'${authLogPath.replaceAll("'", "'\\''")}'`

export default defineConfig({
  testDir: './e2e',
  // 认证入口按 IP 限流（RL_AUTH 每分钟 10 次），串行执行避免并发请求触发 429
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm dev > ${quotedAuthLogPath} 2>&1`,
      url: `http://localhost:${webPort}/api/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
