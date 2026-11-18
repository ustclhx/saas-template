import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'

// replay 用例必须连隔离库，缺失时立即失败（@saas/db/test-database）。
const database = resolveTestDatabase('@saas/storage node-s3', { required: true })
const integration = Boolean(database)
if (database) {
  process.env.NODE_DB_TEST_URL = database.appUrl
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
}

export default defineConfig({
  test: {
    name: 'node-s3',
    environment: 'node',
    include: [
      'test/node-s3/**/*.test.ts',
      'test/node-media/**/*.test.ts',
      ...(integration ? ['test/node-media-replay.integration.test.ts'] : []),
    ],
    ...(integration ? { globalSetup: ['@saas/db/test/global-setup'] } : {}),
    hookTimeout: 120_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
