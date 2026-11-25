import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@saas/db/test/postgres-socket-rejection'
import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'

// 未配置数据库时只跑单元测试；配置了则必须是同一个隔离库（@saas/db/test-database）。
const database = resolveTestDatabase('@saas/storage')
const integration = Boolean(database)
if (database) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = database.appUrl
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
}

export default defineConfig({
  test: {
    // 与 db/web/jobs 复用已确认的 postgres.js workerd socket 关闭处理。
    onUnhandledError: (error) => !isPostgresSocketRejection(error),
    projects: [
      { test: { name: 'unit', include: ['test/**/*.unit.test.ts'] } },
      ...(integration
        ? [
            {
              plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
              test: {
                name: 'integration',
                include: ['test/**/*.integration.test.ts'],
                exclude: ['test/node-media-replay.integration.test.ts'],
                globalSetup: ['@saas/db/test/global-setup'],
                // 本地 R2/KV 经 miniflare 往返，CI 并行负载下分页删除用例曾超过默认 5 秒；与 jobs 集成测试取同一上限。
                testTimeout: 15_000,
              },
            },
          ]
        : []),
    ],
  },
})
