import { getLogContext } from '@saas/shared/log'
import type { WebRuntime } from '../server/runtime.ts'
import { captureNodeError, type NodeWebObserver } from './observer-context.ts'

// Nitro 与 Start 分别构建，资源由 HTTP 入口创建并经原始 Request 显式交给 SSR。
const key = Symbol.for('saas.web.runtime')
type RuntimeRequest = Request & { [key]?: WebRuntime }

export function attachWebRuntime(request: Request, runtime: WebRuntime) {
  ;(request as RuntimeRequest)[key] = runtime
}

export function requestWebRuntime(request: Request): WebRuntime {
  const runtime = (request as RuntimeRequest)[key]
  if (!runtime) throw new Error('Missing Node request runtime')
  const observer = runtime.observability as
    | Pick<NodeWebObserver, 'enabled' | 'captureError'>
    | undefined
  if (!observer) return runtime
  // 复制属性描述符保留惰性 getter 和 own/enumerable，文件 handler 的依赖展开才能保留 db/auth。
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(runtime),
      observability: {
        enumerable: true,
        value: {
          enabled: observer.enabled,
          captureError: (error: unknown) => captureNodeError(observer, error, getLogContext()),
        },
      },
    },
  ) as WebRuntime
}
