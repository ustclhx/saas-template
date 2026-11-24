import { ImageIcon, ListChecks } from '@saas/ui/icons'
import { createServerOnlyFn } from '@tanstack/react-start'
import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'
import { templateConfig } from '@web/server/template-config.ts'
import { mediaAgentTools } from './agent-tools.ts'

const media = () => templateConfig.ai.image || templateConfig.ai.video

/**
 * agent 工具（openspec add-ai-agents 8.1）：只有启用 agents 的 Cloudflare Worker 会读取；agents 未启用时
 * 不提供任何工具。工具依赖服务端模块，按 docs/plugins.md 经 createServerOnlyFn 导出，客户端产物不含实现。
 */
export const agentTools = createServerOnlyFn(() =>
  templateConfig.plugins.agents ? mediaAgentTools() : [],
)

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
