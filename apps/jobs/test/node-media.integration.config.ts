import { fileURLToPath } from 'node:url'
import { assertIsolatedTestDatabase } from '@saas/db/test-database'
import { readLocalEnv } from '@saas/db/worktree-env'
import { defineConfig } from 'vitest/config'
import templateConfig from '../../../template.config.ts'

export default defineConfig(() => {
  if (!templateConfig.plugins.media) return { test: { include: [], passWithNoTests: true } }

  const app = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
  const migrator = readLocalEnv('MIGRATION_DATABASE_URL')
  if (!app || !migrator)
    throw new Error('Node media integration requires worktree PG configuration')
  const appUrl = new URL(app)
  const migrationUrl = new URL(migrator)
  assertIsolatedTestDatabase({ app, migrator }, '@saas/jobs node media')
  if (appUrl.username !== 'app' || migrationUrl.username !== 'migrator')
    throw new Error('Node media integration requires app/migrator on the same isolated worktree PG')
  process.env.TEST_JOB_DATABASE_URL = app
  process.env.MIGRATION_DATABASE_URL = migrator
  process.env.TEST_JOB_MIGRATOR_URL = migrator

  return {
    resolve: {
      alias: { '@web': fileURLToPath(new URL('../../web/src', import.meta.url)) },
    },
    test: {
      include: ['test/node-media.integration.test.ts'],
      fileParallelism: false,
      globalSetup: ['test/node-jobs-setup.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }
})
