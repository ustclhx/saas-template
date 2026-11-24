// Node（selfhost）jobs 侧插件扩展点；两目标共用部分见 ../plugins/contract.ts。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TemplateConfig } from '@saas/config'
import type { NodeEnv, NodeStorageConfig } from '@saas/config/node'
import type { createNodeWorkflow } from '@saas/platform/node'
import type { JobObserver } from '../observer.ts'
import type { JobsPluginModule } from '../plugins/contract.ts'

/** Node 持久任务装配所需的资源；在 engine.register 内调用 */
export interface NodePluginWorkflowContext {
  readonly engine: Parameters<typeof createNodeWorkflow>[0]['engine']
  readonly config: NodeEnv
  readonly template: TemplateConfig
  readonly observer: JobObserver
  readonly storage: NodeStorageConfig | undefined
}

/** Node 目标注册的持久任务：内部 HTTP 路由（web 经它启动任务）与停机时停止接收 */
export interface NodePluginWorkflows {
  readonly http?: Readonly<
    Record<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>
  >
  stopReceiving?(): void
}

/** Node（selfhost）jobs 入口：在共用部分之外注册 Node 持久任务（Cloudflare 上对应 Workflow 类） */
export interface JobsNodePluginModule extends JobsPluginModule {
  registerWorkflows?(context: NodePluginWorkflowContext): NodePluginWorkflows | undefined
}

/** Cloudflare jobs 注册：只声明绑定、没有 jobs 入口的插件也在列表中，entry 省略 */
export interface JobsNodePluginRegistration {
  readonly id: string
  readonly entry: JobsNodePluginModule
}
