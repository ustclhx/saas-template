import { defineConfig } from 'vitest/config'
import { generatePlugins, pluginMessageDirs } from '../../scripts/plugins/plugins.mjs'
import templateConfig from '../../template.config.ts'
import { i18nMessages } from './scripts/i18n-project.ts'
import { webAlias } from './scripts/web-alias.ts'
import { APP_AREA_PREFIXES } from './src/features/i18n/app-area.ts'

const { plugins } = await generatePlugins({ config: templateConfig, notify: () => {} })

/** public 冒烟不读取生产凭据，也不要求数据库或缓存服务。 */
export default defineConfig({
  plugins: [
    webAlias(),
    i18nMessages({
      i18n: templateConfig.i18n,
      appAreaPrefixes: APP_AREA_PREFIXES,
      // Node 目标：只编译支持 selfhost 的启用插件文案
      messageDirs: pluginMessageDirs(plugins, 'node'),
    }),
  ],
  test: {
    environment: 'node',
    include: [
      'src/features/i18n/**/*.test.ts',
      'src/features/marketing/**/*.test.ts',
      'src/features/seo/**/*.test.{ts,tsx}',
      'test/public-node/*.node.ts',
    ],
  },
})
