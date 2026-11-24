import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { isPostgresSocketRejection } from '@saas/db/test/postgres-socket-rejection'
import { resolveTestDatabase } from '@saas/db/test-database'
import { defineConfig } from 'vitest/config'
import { generatePlugins, pluginMessageDirs } from '../../scripts/plugins/plugins.mjs'
import templateConfig from '../../template.config.ts'
import { i18nMessages } from './scripts/i18n-project.ts'
import { webAlias } from './scripts/web-alias.ts'
import { APP_AREA_PREFIXES } from './src/features/i18n/app-area.ts'

// 测试库按环境变量、.env.worktree、本地 <项目>_test 的顺序解析。
// ALLOW_TEST_ON_DEV_DATABASE=1 时允许使用开发库。
// CI 中未显式提供连接串时跳过集成测试，只跑单元测试（与 @saas/db 一致）。
const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const database = resolveTestDatabase('@saas/web', { devFallback: true })
const appUrl = database?.appUrl
const migratorUrl = database?.migratorUrl

// 与 vite dev / build 一致：生成插件注册文件，并编译启用插件的文案
const { plugins: enabledPlugins } = await generatePlugins({ config: templateConfig })

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
        plugins: [
          webAlias(),
          i18nMessages({
            i18n: templateConfig.i18n,
            appAreaPrefixes: APP_AREA_PREFIXES,
            messageDirs: pluginMessageDirs(enabledPlugins, 'cloudflare'),
          }),
        ],
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
      ...(integration
        ? [
            {
              plugins: [
                webAlias(),
                cloudflareTest(({ inject }) => ({
                  wrangler: { configPath: './test/wrangler.jsonc' },
                  miniflare: {
                    hyperdrives: {
                      HYPERDRIVE_HANGING: `postgres://app:app@127.0.0.1:${inject('hangingDbPort')}/db`,
                      HYPERDRIVE_REFUSED: `postgres://app:app@127.0.0.1:${inject('refusedDbPort')}/db`,
                      // audit_log 对 app 只追加（@saas/db 迁移 0009），清理审计行改用 migrator
                      HYPERDRIVE_MIGRATOR: migratorUrl,
                    },
                  },
                })),
              ],
              test: {
                name: 'integration',
                // 多个测试会改写全局运行时设置（如 auth.signupEnabled 关闭注册），与并行运行的
                // 注册类测试共享同一个隔离库会偶发 403；与 @saas/billing 的 postgres 项目一样串行执行。
                fileParallelism: false,
                include: ['test/**/*.test.ts'],
                globalSetup: ['./test/global-setup.ts'],
              },
            },
          ]
        : []),
    ],
  },
})
