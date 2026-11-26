// web 侧插件扩展点（openspec add-plugin-system 决策 5）。插件入口模块的 default 导出符合下面的接口，
// 由 scripts/plugins/generate.mjs 生成的 plugins*.gen.ts 汇总；核心只从生成文件读取，不直接导入插件。
// 只开放这些扩展点，不够用时再按需新增并记录在 docs/plugins.md。Cloudflare Worker 入口的约定见
// server/cloudflare/plugins.ts（含 Cloudflare 类型，不进入目标中立的类型检查），Node 入口的约定见
// node/plugins.ts（只供 Node 目标引用，本文件不依赖 Node 配置类型）。
import type { AgentToolContext, AgentToolContribution } from '@saas/ai'
import type { Database } from '@saas/db'
import type { RateLimiter } from '@saas/platform'
import type { FileRoutesByTo } from '../../routeTree.gen.ts'
import type { WebAiRuntime } from '../../server/runtime.ts'
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
  /** 导航项上的待处理数量（如待确认操作）；后台布局加载时读取，失败或为 0 时不显示 */
  count?: () => Promise<number>
}

/** web 入口（两目标共用，含客户端）：导航、对话消息部件渲染器与附加站点地图 */
export interface WebPluginModule {
  /** 应用区侧边栏条目；顶部布局（ui.appLayout: 'topbar'）也会渲染这些条目 */
  appNav?: readonly { group: AppNavGroupId; items: readonly AppNavItem[] }[]
  adminNav?: readonly AdminNavEntry[]
  /** 对话中工具调用卡片的显示名与详情，键为工具名；项目在 message-parts.project.tsx 中可覆盖 */
  toolRenderers?: Readonly<Record<string, ToolRenderer>>
  /** 站点根路径下的附加站点地图，由 robots.txt 列出 */
  sitemaps?: readonly string[]
}

/** fetch 前置处理：在 Start 处理之前依次调用，返回 Response 即结束；返回 undefined 交给下一个 */
export type PluginFetch<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | undefined | Promise<Response | undefined>

export interface WebPluginRegistration {
  readonly id: string
  readonly entry: WebPluginModule
}

/**
 * agent 工具在对话实例（Durable Object）中执行时可用的服务。实例不在 web 的请求运行时中，
 * 这些依赖由 agents 插件按 Worker 绑定装配；工具只读取自己需要的密钥与绑定。
 * 与 plugins/agents/src/tool-context.ts 同形（agents 插件不经 @web 引用本类型，便于独立类型检查）。
 */
export interface AgentToolServices {
  /** Worker 的绑定与变量（只读） */
  readonly env: Readonly<Record<string, unknown>>
  /** 插件 Worker 入口提供的 AI 任务工作流，与 web 运行时的 `ai.workflow` 同源 */
  readonly aiWorkflow: WebAiRuntime['workflow']
  readonly rateLimiter: RateLimiter
}

/** 插件工具的执行上下文；`services` 只在对话实例中提供，测试等场景可能缺省 */
export type PluginAgentToolContext = AgentToolContext<Database, AgentToolServices | undefined>

/** web 入口可具名导出 agentTools，只有启用 agents 的 Worker 会读取它。 */
export interface WebAgentToolRegistration {
  readonly id: string
  readonly entry: {
    readonly default: WebPluginModule
    readonly agentTools?: AgentToolContribution<PluginAgentToolContext>
  }
}
