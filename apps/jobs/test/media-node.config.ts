import { fileURLToPath } from 'node:url'
import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'
import templateConfig from '../../../template.config.ts'

export default defineConfig(() => {
  if (!templateConfig.plugins.media) return { test: { include: [], passWithNoTests: true } }

  const { appUrl, migratorUrl } =
    resolveTestDatabase('@saas/jobs media node', { required: true }) ?? {}
  if (!appUrl || !migratorUrl) throw new Error('Media tests require isolated worktree database')
  process.env.TEST_JOB_DATABASE_URL = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl

  return {
    resolve: {
      alias: {
        'cloudflare:workers': fileURLToPath(
          new URL('./fixtures/media-node-env.ts', import.meta.url),
        ),
        '@saas/storage/cloudflare': fileURLToPath(
          new URL('./fixtures/media-node-storage.ts', import.meta.url),
        ),
      },
    },
    test: {
      environment: 'node',
      include: [
        'test/media-workflow.test.ts',
        'test/media-settlement.test.ts',
        'test/media-hold-sweep.test.ts',
      ],
      fileParallelism: false,
      globalSetup: ['@saas/db/test/global-setup'],
    },
  }
})
