import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'

// 认证页面的 e2e（tasks.md 7.2）：在本地 `vite dev`（web）+ `wrangler dev`（jobs）上运行，
// 端口取自 Orca worktree 的 .env.worktree（docs/09-parallel-plan.md §2），不存在时用默认端口。
// 已在运行的 dev 进程直接复用；否则由 Playwright 启动，结束后只停止它自己启动的进程。
const repoRoot = new URL('../../', import.meta.url).pathname
const worktreeEnv = loadEnv('worktree', repoRoot, '')
const webPort = Number(worktreeEnv.WEB_PORT ?? 3000)
const jobsPort = Number(worktreeEnv.JOBS_PORT ?? 8788)

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
      command: 'pnpm dev',
      url: `http://localhost:${webPort}/api/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // EMAIL_QUEUE 的消费者（log 通道，不调用外部服务）
      command: 'pnpm --filter @saas/jobs dev',
      port: jobsPort,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
