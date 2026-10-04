import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { isPostgresSocketRejection } from '@saas/db/test/postgres-socket-rejection'
import { readLocalEnv } from '@saas/db/worktree-env'
import { defineConfig } from 'vitest/config'

// 集成测试连接的本地库：环境变量 → .env.worktree → 主 checkout 的 saas_dev。
// CI 中未显式提供连接串时跳过集成测试，只跑单元测试（与 @saas/db 一致）。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const fallback = (url: string) => (process.env.CI ? undefined : url)
const appUrl =
  readLocalEnv(HYPERDRIVE_ENV) ?? fallback('postgres://app:app@localhost:5432/saas_dev')
const migratorUrl =
  readLocalEnv('MIGRATION_DATABASE_URL') ??
  fallback('postgres://migrator:migrator@localhost:5432/saas_dev')

const integration = appUrl && migratorUrl
if (integration) {
  process.env[HYPERDRIVE_ENV] = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
} else {
  console.warn(`[@saas/auth] 未配置 ${HYPERDRIVE_ENV}，跳过集成测试`)
}

export default defineConfig({
  test: {
    // postgres.js 在 workerd 中连接失败 / 断开时内部未处理的 rejection，见该函数注释
    onUnhandledError: (error) => !isPostgresSocketRejection(error),
    projects: [
      {
        test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      ...(integration
        ? [
            {
              plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
              test: {
                name: 'integration',
                include: ['test/**/*.test.ts'],
                globalSetup: ['@saas/db/test/global-setup'],
              },
            },
          ]
        : []),
    ],
  },
})
