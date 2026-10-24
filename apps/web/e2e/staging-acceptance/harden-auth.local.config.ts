import { defineConfig } from '@playwright/test'
import { hardenProjects } from './harden-auth.config.ts'
import local from './local.config.ts'

// 复用 local.config.ts 的隔离库校验与本地账号种子；dev 服务改用 harden 的 vite 配置并写独立日志，
// 避免与其它 worktree 同时运行的验收共用 /tmp 日志文件。
export default defineConfig({
  ...local,
  projects: hardenProjects,
  webServer: {
    ...(local.webServer as Exclude<typeof local.webServer, unknown[] | undefined>),
    command:
      'pnpm exec vite dev --config e2e/staging-acceptance/harden-auth.local.vite.ts > ../../test-results/harden-auth-local.log 2>&1',
  },
})
