import { LayoutGrid, Sparkles } from '@saas/ui/icons'
import { createServerOnlyFn } from '@tanstack/react-start'
import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'
import { templateConfig } from '@web/server/template-config.ts'
import { enabledStudioKinds } from '../kinds.ts'
import { studioWorksList, studioWorksModerate } from './admin-mcp-tools.ts'

// 没有启用的模式（插件配置与模板 AI 开关求交为空）时两个入口都不显示，页面同样返回 404。
const studio = () => enabledStudioKinds(templateConfig).length > 0

export default {
  appNav: [
    {
      group: 'tools',
      items: [
        {
          id: 'studio',
          label: m.studio_create,
          icon: Sparkles,
          to: '/app/$slug/studio',
          order: 20,
          topbarOrder: 20,
          visible: studio,
        },
      ],
    },
    {
      group: 'content',
      items: [
        {
          id: 'studio-works',
          label: m.studio_my_works,
          icon: LayoutGrid,
          to: '/app/$slug/studio/works',
          order: 5,
          topbarOrder: 5,
          visible: studio,
        },
      ],
    },
  ],
  sitemaps: ['/sitemap-gallery.xml'],
} satisfies WebPluginModule

export const adminMcpTools = createServerOnlyFn(() => ({
  'studio.works.list': studioWorksList,
  'studio.works.moderate': studioWorksModerate,
}))
