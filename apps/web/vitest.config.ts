import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { isPostgresSocketRejection } from '@saas/db/test/postgres-socket-rejection'
import { readLocalEnv } from '@saas/db/worktree-env'
import { defineConfig } from 'vitest/config'
import templateConfig from '../../template.config.ts'
import { i18nMessages } from './scripts/i18n-project.ts'
import { APP_AREA_PREFIXES } from './src/features/i18n/app-area.ts'

// 集成测试连接的本地库：环境变量 → .env.worktree → 主 checkout 的 saas_dev。
// CI 中未显式提供连接串时跳过集成测试，只跑单元测试（与 @saas/db 一致）。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const fallback = (url: string) => (process.env.CI ? undefined : url)
const appUrl =
  readLocalEnv(HYPERDRIVE_ENV) ?? fallback('postgres://app:app@localhost:5432/saas_dev')
const migratorUrl =
  readLocalEnv('MIGRATION_DATABASE_URL') ??
  fallback('postgres://migrator:migrator@localhost:5432/saas_dev')

const integration = appUrl && migratorUrl
if (integration) {
  process.env[HYPERDRIVE_ENV] = appUrl
  process.env.MIGRATION_DATABASE_URL = migratorUrl
} else {
  console.warn(`[@saas/web] 未配置 ${HYPERDRIVE_ENV}，跳过集成测试`)
}

export default defineConfig({
  test: {
    // postgres.js 在 workerd 中连接失败 / 断开时内部未处理的 rejection，见该函数注释
    onUnhandledError: (error) => !isPostgresSocketRejection(error),
    projects: [
      {
        // 单元测试会引用 Paraglide 编译产物（src/paraglide），与 vite dev / build 一样先编译
        plugins: [i18nMessages({ i18n: templateConfig.i18n, appAreaPrefixes: APP_AREA_PREFIXES })],
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
      ...(integration
        ? [
            {
              plugins: [
                cloudflareTest(({ inject }) => ({
                  wrangler: { configPath: './test/wrangler.jsonc' },
                  miniflare: {
                    hyperdrives: {
                      HYPERDRIVE_HANGING: `postgres://app:app@127.0.0.1:${inject('hangingDbPort')}/db`,
                      HYPERDRIVE_REFUSED: `postgres://app:app@127.0.0.1:${inject('refusedDbPort')}/db`,
                    },
                  },
                })),
              ],
              test: {
                name: 'integration',
                include: ['test/**/*.test.ts'],
                globalSetup: ['./test/global-setup.ts'],
              },
            },
          ]
        : []),
    ],
  },
})
