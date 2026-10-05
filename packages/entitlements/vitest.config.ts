import { readLocalEnv } from '@saas/db/worktree-env'
import { defineConfig } from 'vitest/config'

const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
if (migrationUrl) process.env.MIGRATION_DATABASE_URL = migrationUrl

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('./test/workers-env.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    ...(migrationUrl ? { globalSetup: ['@saas/db/test/global-setup'] } : {}),
  },
})
