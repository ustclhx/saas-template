import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'
import { webAlias } from './scripts/web-alias.ts'

const { appUrl, migratorUrl } = resolveTestDatabase('@saas/web ai node', { required: true }) ?? {}
if (!appUrl || !migratorUrl) throw new Error('Node AI tests require isolated database URLs')
process.env.NODE_AI_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  // 插件代码经 @web/* 访问 web 核心模块
  plugins: [webAlias()],
  test: {
    environment: 'node',
    include: ['test/ai-node/*.node.ts'],
    globalSetup: ['@saas/db/test/global-setup'],
  },
})
