import { Bot } from '@saas/ui/icons'
import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { m } from '@web/paraglide/messages.js'
import { templateConfig } from '@web/server/template-config.ts'
import { exampleToolRenderers } from './tool-renderers.tsx'

// agents 插件的 web 入口（openspec add-ai-agents 6.2）：应用区导航与示例工具的卡片渲染器。
// agent 使用文本模型，文本对话关闭时不显示入口（页面与服务端函数仍由插件启用与计费开关决定）。

export default {
  appNav: [
    {
      group: 'tools',
      items: [
        {
          id: 'agents',
          label: m.agents_title,
          icon: Bot,
          to: '/app/$slug/agents',
          order: 15,
          topbarOrder: 15,
          visible: () => templateConfig.ai.text.enabled,
        },
      ],
    },
  ],
  toolRenderers: exampleToolRenderers,
} satisfies WebPluginModule
