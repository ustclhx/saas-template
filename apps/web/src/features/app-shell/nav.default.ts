import {
  ChartColumn,
  CreditCard,
  House,
  KeyRound,
  MessageSquare,
  SlidersHorizontal,
} from '@saas/ui/icons'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { type AppNavContext, registerAppNav } from './nav.ts'

// 模板自带的导航条目，可见性与原顶部布局一致（模板开关 + 角色）；项目条目写在 nav.project.ts。
// 由 registry.ts 调用，不在导入时登记（热更新时注册表先清空再重新登记）。
const manager = ({ role }: AppNavContext) => role === 'owner' || role === 'admin'

/** 顶部布局里已有固定链接的模板条目；topbar 只额外渲染注册表中这些 id 之外的条目 */
export const TEMPLATE_NAV_IDS = [
  'home',
  'chat',
  'billing',
  'usage',
  'api-keys',
  'workspace-settings',
] as const

export function registerDefaultAppNav() {
  registerAppNav({
    group: 'tools',
    items: [
      {
        id: 'home',
        label: m.app_shell_nav_home,
        icon: House,
        to: '/app/$slug',
        exact: true,
        order: 0,
      },
      {
        id: 'chat',
        label: m.app_chat,
        icon: MessageSquare,
        to: '/app/$slug/chat',
        order: 10,
        visible: () => templateConfig.ai.text.enabled,
      },
    ],
  })

  registerAppNav({
    group: 'settings',
    items: [
      {
        id: 'billing',
        label: m.app_billing,
        icon: CreditCard,
        to: '/app/$slug/billing',
        order: 10,
        visible: () => templateConfig.billing.enabled,
      },
      {
        id: 'usage',
        label: m.app_usage,
        icon: ChartColumn,
        to: '/app/$slug/usage',
        order: 20,
        visible: () => templateConfig.credits.enabled,
      },
      {
        id: 'api-keys',
        label: m.app_shell_nav_api_keys,
        icon: KeyRound,
        to: '/app/$slug/api-keys',
        search: { page: 0 },
        order: 30,
        visible: (context) =>
          templateConfig.billing.enabled && templateConfig.features.publicApi && manager(context),
      },
      {
        id: 'workspace-settings',
        label: m.app_workspace_settings,
        icon: SlidersHorizontal,
        to: '/app/$slug/settings',
        order: 40,
      },
    ],
  })
}
