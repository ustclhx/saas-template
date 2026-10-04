import { readLocalEnv } from '@saas/db/worktree-env'
import { defineConfig } from 'vitest/config'

const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
for (const url of [appUrl, migrationUrl]) {
  if (!url || new URL(url).pathname !== '/saas_wt_p2_ledger_core') {
    throw new Error('Credits tests require isolated saas_wt_p2_ledger_core database')
  }
}
process.env.CREDITS_TEST_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migrationUrl

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['@saas/db/test/global-setup'],
  },
})
