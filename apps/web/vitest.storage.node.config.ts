import { defineConfig } from 'vitest/config'
import { webAlias } from './scripts/web-alias.ts'

if (
  !process.env.NODE_STORAGE_DATABASE_URL ||
  !process.env.TEST_VALKEY_URL ||
  !process.env.S3_ENDPOINT
)
  throw new Error('Run scripts/test-node-storage.mjs for isolated storage resources')

export default defineConfig({
  // 插件代码经 @web/* 访问 web 核心模块
  plugins: [webAlias()],
  test: {
    environment: 'node',
    include: [
      'src/node/storage-http.node.ts',
      'src/node/sentry-http.node.ts',
      'src/features/files/http.test.ts',
    ],
    globalSetup: ['@saas/db/test/global-setup'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
