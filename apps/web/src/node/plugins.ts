// Node（selfhost）web 侧插件扩展点；两目标共用部分见 ../features/plugins/contract.ts。
// 与 apps/jobs/src/node/plugins.ts 对称：只有 plugins.node.gen.ts 与 Node 入口引用本文件，
// 只部署 Cloudflare 的项目删除 src/node 下的 Node 入口后，插件生成器不再写出 Node 注册文件。
import type { NodeEnv } from '@saas/config/node'
import type { Storage } from '@saas/storage'
import type { PluginFetch } from '../features/plugins/contract.ts'
import type { WebAiRuntime } from '../server/runtime.ts'

/** Node（selfhost）web 入口 */
export interface WebNodePluginModule {
  fetch?: PluginFetch<[]>
  createAiWorkflow?: (options: {
    env: NodeEnv
    jobsUrl: string
    storage: Storage | undefined
  }) => WebAiRuntime['workflow']
}

export interface WebNodePluginRegistration {
  readonly id: string
  readonly entry: WebNodePluginModule
}
