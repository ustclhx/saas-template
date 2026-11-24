// Cloudflare Worker 侧插件扩展点（openspec add-plugin-system 决策 5）；目标中立部分见 features/plugins/contract.ts。
import type { PluginBinding } from '@saas/config'
import type { PluginFetch } from '../../features/plugins/contract.ts'

/** Worker 入口：default 导出前置处理；具名导出（Durable Object 类等）由 server.ts 原样导出 */
export interface WorkerPluginModule {
  fetch?: PluginFetch<[env: Cloudflare.Env, ctx: ExecutionContext]>
}

/** 只声明绑定、没有 worker 入口的插件也在列表中，entry 省略；bindings 为清单 bindings.web */
export interface WorkerPluginRegistration {
  readonly id: string
  readonly entry?: WorkerPluginModule
  readonly bindings: readonly Pick<PluginBinding, 'name' | 'kind' | 'optional'>[]
}
