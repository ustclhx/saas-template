import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'

// 未配置数据库时只跑离线用例；配置了则必须是同一个隔离库（@saas/db/test-database）。
const database = resolveTestDatabase('@saas/entitlements')
if (database) {
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
  process.env.ENTITLEMENTS_TEST_DATABASE_URL = database.appUrl
}

export default defineConfig({
  test: {
    environment: 'node',
    ...(database ? { globalSetup: ['@saas/db/test/global-setup'] } : {}),
  },
})
