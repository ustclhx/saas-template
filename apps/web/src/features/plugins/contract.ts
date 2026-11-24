// web 侧插件扩展点（openspec add-plugin-system 决策 5）。插件入口模块的 default 导出符合下面的接口，
// 由 scripts/plugins/generate.mjs 生成的 plugins*.gen.ts 汇总；核心只从生成文件读取，不直接导入插件。
// 只开放这些扩展点，不够用时再按需新增并记录在 docs/plugins.md。Cloudflare Worker 入口的约定见
// server/cloudflare/plugins.ts（含 Cloudflare 类型，不进入目标中立的类型检查）。
import type { FileRoutesByTo } from '../../routeTree.gen.ts'
import type { ToolRenderer } from '../ai/tool-renderers.ts'
import type { AppNavGroupId, AppNavItem } from '../app-shell/nav.ts'

export type AdminNavGroupId = 'people' | 'billing' | 'ai' | 'operations'

/** 后台菜单条目：追加到已有分组末尾，按 order 排序（默认 100） */
export interface AdminNavEntry {
  group: AdminNavGroupId
  to: Extract<keyof FileRoutesByTo, `/admin/${string}`>
  /** 列表页从第一页开始时传 `{ offset: 0 }` */
  search?: Record<string, unknown>
  /** 按请求语言取文案 */
  label: () => string
  order?: number
}

/** web 入口（两目标共用，含客户端）：导航、后台菜单与对话消息部件渲染器 */
export interface WebPluginModule {
  /** 应用区侧边栏条目；顶部布局（ui.appLayout: 'topbar'）也会渲染这些条目 */
  appNav?: readonly { group: AppNavGroupId; items: readonly AppNavItem[] }[]
  adminNav?: readonly AdminNavEntry[]
  /** 对话中工具调用卡片的显示名与详情，键为工具名；项目在 message-parts.project.tsx 中可覆盖 */
  toolRenderers?: Readonly<Record<string, ToolRenderer>>
}

/** fetch 前置处理：在 Start 处理之前依次调用，返回 Response 即结束；返回 undefined 交给下一个 */
export type PluginFetch<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | undefined | Promise<Response | undefined>

/** Node（selfhost）web 入口 */
export interface WebNodePluginModule {
  fetch?: PluginFetch<[]>
}

export interface WebPluginRegistration {
  readonly id: string
  readonly entry: WebPluginModule
}
export interface WebNodePluginRegistration {
  readonly id: string
  readonly entry: WebNodePluginModule
}
