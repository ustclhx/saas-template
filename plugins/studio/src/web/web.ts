import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'

export default {
  sitemaps: ['/sitemap-gallery.xml'],
  adminNav: [
    // 后台作品审核（add-media-studio 任务 7.2）：数量 = 待审核 + 已隐藏（design 决策 8），
    // 读取入口按需 import()，不进后台入口包的水合闭包
    {
      group: 'operations',
      to: '/admin/studio',
      search: { offset: 0 },
      label: m.studio_admin_nav,
      order: 80,
      count: () =>
        import('./moderation.functions.ts').then(({ getAdminStudioWorkCount }) =>
          getAdminStudioWorkCount(),
        ),
    },
  ],
} satisfies WebPluginModule
