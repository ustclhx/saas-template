import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'
import { webAlias } from './scripts/web-alias.ts'

const { appUrl, migratorUrl } =
  resolveTestDatabase('@saas/web production node', { required: true }) ?? {}
const valkeyUrl = process.env.TEST_VALKEY_URL
if (!appUrl || !migratorUrl || !valkeyUrl)
  throw new Error('Production smoke requires isolated PG and Valkey')
process.env.NODE_PRODUCTION_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  // 插件代码经 @web/* 访问 web 核心模块
  plugins: [webAlias()],
  test: {
    environment: 'node',
    include: ['test/fixtures/production-node/*.node.ts'],
    globalSetup: ['@saas/db/test/global-setup'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
})
