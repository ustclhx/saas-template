import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'

const database = resolveTestDatabase('@saas/plugin-studio')
if (database) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = database.appUrl
  process.env.MIGRATION_DATABASE_URL = database.migratorUrl
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts'],
        },
      },
      ...(database
        ? [
            {
              test: {
                name: 'integration',
                include: ['test/**/*.integration.test.ts'],
                globalSetup: ['@saas/db/test/global-setup'],
                testTimeout: 15_000,
              },
            },
          ]
        : []),
    ],
  },
})
