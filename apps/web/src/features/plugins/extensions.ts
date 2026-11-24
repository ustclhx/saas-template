// 把生成文件中的插件入口合并到核心注册表；纯函数，便于单元测试。
import type { ToolRenderer } from '../ai/tool-renderers.ts'
import type { AppNavGroupId, AppNavItem } from '../app-shell/nav.ts'
import type {
  AdminNavEntry,
  AdminNavGroupId,
  PluginFetch,
  WebPluginRegistration,
} from './contract.ts'

/** 按插件 id 顺序（生成文件已排序）登记应用区导航；同 id 的条目后登记者覆盖 */
export function registerPluginAppNav(
  plugins: readonly WebPluginRegistration[],
  register: (input: { group: AppNavGroupId; items: AppNavItem[] }) => void,
) {
  for (const { entry } of plugins)
    for (const nav of entry.appNav ?? []) register({ group: nav.group, items: [...nav.items] })
}

/** 指定分组的插件后台菜单，按 order（默认 100）与插件顺序排列 */
export function pluginAdminNav(
  plugins: readonly WebPluginRegistration[],
  group: AdminNavGroupId,
): AdminNavEntry[] {
  return plugins
    .flatMap(({ entry }) => entry.adminNav ?? [])
    .filter((item) => item.group === group)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100) || a.index - b.index)
    .map(({ item }) => item)
}

export function registerPluginToolRenderers(
  plugins: readonly WebPluginRegistration[],
  register: (toolName: string, renderer: ToolRenderer) => void,
) {
  for (const { entry } of plugins)
    for (const [toolName, renderer] of Object.entries(entry.toolRenderers ?? {}))
      register(toolName, renderer)
}

/** 依次调用插件的 fetch 前置处理；第一个返回 Response 的插件结束链路，都不处理时返回 undefined */
export async function runPluginFetch<Args extends unknown[]>(
  plugins: readonly { readonly id: string; readonly entry?: { fetch?: PluginFetch<Args> } }[],
  request: Request,
  ...args: Args
): Promise<Response | undefined> {
  for (const { entry } of plugins) {
    const response = await entry?.fetch?.(request, ...args)
    if (response) return response
  }
  return undefined
}
