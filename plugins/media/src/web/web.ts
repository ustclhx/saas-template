import { ImageIcon, ListChecks } from '@saas/ui/icons'
import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'
import { templateConfig } from '@web/server/template-config.ts'

const media = () => templateConfig.ai.image || templateConfig.ai.video

export default {
  appNav: [
    {
      group: 'tools',
      items: [
        {
          id: 'media',
          label: m.media_title,
          icon: ImageIcon,
          to: '/app/$slug/media/new',
          order: 20,
          topbarOrder: 20,
          visible: media,
        },
      ],
    },
    {
      group: 'content',
      items: [
        {
          id: 'media-tasks',
          label: m.media_tasks_title,
          icon: ListChecks,
          to: '/app/$slug/tasks',
          order: 10,
          topbarOrder: 10,
          visible: media,
        },
      ],
    },
  ],
} satisfies WebPluginModule
