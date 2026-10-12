import type { WebRuntime } from '../server/runtime.ts'

// Nitro 与 Start 分别构建，资源由 HTTP 入口创建并经原始 Request 显式交给 SSR。
const key = Symbol.for('saas.web.runtime')
type RuntimeRequest = Request & { [key]?: WebRuntime }

export function attachWebRuntime(request: Request, runtime: WebRuntime) {
  ;(request as RuntimeRequest)[key] = runtime
}

export function requestWebRuntime(request: Request): WebRuntime {
  const runtime = (request as RuntimeRequest)[key]
  if (!runtime) throw new Error('Missing Node request runtime')
  return runtime
}
