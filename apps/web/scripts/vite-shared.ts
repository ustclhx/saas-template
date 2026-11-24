import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import contentCollections from '@content-collections/vite'
import type { PluginTarget } from '@saas/config'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import {
  generatePlugins,
  NODE_WEB_ALIASES,
  pluginMessageDirs,
  pluginRouteConfig,
  REPO_ROOT,
} from '../../../scripts/plugins/plugins.mjs'
import templateConfig from '../../../template.config.ts'
import { APP_AREA_PREFIXES } from '../src/features/i18n/app-area.ts'
import { isPrerenderedPath, prerenderEntryPages } from '../src/features/marketing/prerender.ts'
import { clientPureSchemas } from './client-pure-schemas.ts'
import { clientTemplateConfig } from './client-template-config.ts'
import { activeLocales, i18nMessages } from './i18n-project.ts'
import { webAlias } from './web-alias.ts'

const templateConfigFile = fileURLToPath(new URL('../../../template.config.ts', import.meta.url))

// 解析配置时生成插件注册文件并校验 plugins 段（scripts/plugins/generate.mjs 的同一实现），配置错误即构建失败
const { plugins: enabledPlugins } = await generatePlugins({ config: templateConfig })

/**
 * Node 构建把两目标共用的 plugins.gen.ts / plugins.gen.css 解析为 Node 版本，排除仅 Cloudflare 的插件。
 */
function nodePluginRegistry(): Plugin {
  const aliases = new Map(
    Object.entries(NODE_WEB_ALIASES).map(([from, to]) => [
      join(REPO_ROOT, from),
      join(REPO_ROOT, to),
    ]),
  )
  return {
    name: 'saas:node-plugin-registry',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.includes('plugins.gen.')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      const target = resolved && aliases.get(resolved.id)
      return target ?? null
    },
  }
}

/** 两目标共用内容、文案、插件路由与预渲染范围；平台插件留在各自配置中。 */
export function sitePlugins(serverEntry?: string, target: PluginTarget = 'cloudflare') {
  const { i18n, marketing } = templateConfig
  const locales = activeLocales(i18n)
  return [
    webAlias(),
    ...(target === 'node' ? [nodePluginRegistry()] : []),
    clientTemplateConfig(templateConfigFile, templateConfig),
    clientPureSchemas(),
    tailwindcss(),
    i18nMessages({
      i18n,
      appAreaPrefixes: APP_AREA_PREFIXES,
      messageDirs: pluginMessageDirs(enabledPlugins, target),
    }),
    contentCollections(),
    tanstackStart({
      // 核心 src/routes 原样挂在根下，再挂载目标支持的启用插件路由目录（openspec add-plugin-system 决策 4）
      router: { virtualRouteConfig: pluginRouteConfig(REPO_ROOT, enabledPlugins, target) },
      ...(serverEntry ? { server: { entry: serverEntry } } : {}),
      pages: marketing.enabled ? prerenderEntryPages(locales, i18n.defaultLocale) : [],
      prerender: {
        enabled: marketing.enabled,
        crawlLinks: true,
        autoStaticPathsDiscovery: false,
        autoSubfolderIndex: false,
        filter: (page) => isPrerenderedPath(page.path, locales),
      },
    }),
    viteReact(),
  ]
}
