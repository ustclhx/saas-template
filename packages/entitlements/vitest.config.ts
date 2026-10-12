import { readLocalEnv } from '@saas/db/worktree-env'
import { defineConfig } from 'vitest/config'

const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
const appUrl = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
if (appUrl || migrationUrl) {
  if (!appUrl || !migrationUrl) throw new Error('Entitlements tests require both database URLs')
  const app = new URL(appUrl)
  const migrator = new URL(migrationUrl)
  if (
    app.host !== migrator.host ||
    app.pathname !== migrator.pathname ||
    (!app.pathname.startsWith('/saas_wt_') && !(process.env.CI && app.pathname === '/saas_ci'))
  )
    throw new Error('Entitlements tests require matching isolated worktree or CI databases')
  process.env.MIGRATION_DATABASE_URL = migrationUrl
  process.env.ENTITLEMENTS_TEST_DATABASE_URL = appUrl
}

export default defineConfig({
  test: {
    environment: 'node',
    ...(migrationUrl ? { globalSetup: ['@saas/db/test/global-setup'] } : {}),
  },
})
