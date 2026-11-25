import * as projectGate from '../project-gate.ts'

/** 项目闸门（server/project-gate.ts）收到的上下文；钩子运行在环境校验与运行时之前。 */
export interface ProjectGateContext {
  env: Cloudflare.Env
  /** 环境校验是否通过；失败时钩子仍先执行，之后动态请求返回 500。 */
  envValid: boolean
}

/** Response 直接返回；Request 为只用于查找静态资源的改写请求；undefined 表示不处理。 */
export type ProjectGateResult = Response | Request | undefined

export interface ProjectGate {
  staticFirst: boolean
  gateProjectRequest(
    request: Request,
    context: ProjectGateContext,
  ): ProjectGateResult | Promise<ProjectGateResult>
}

/**
 * 运行时之前的响应：先经项目闸门，再查预渲染静态资源；null 表示交给环境校验结果与 TanStack Start。
 * staticFirst 为 true（默认）时环境校验失败也先返回命中的静态资源（public-site-availability）；
 * 为 false 时只在校验通过后查静态资源。返回的响应都按静态响应补安全头。
 */
export async function responseBeforeRuntime(
  request: Request,
  context: ProjectGateContext,
  gate: ProjectGate = projectGate,
): Promise<Response | null> {
  const gated = await gate.gateProjectRequest(request, context)
  if (gated instanceof Response) return gated
  if (!gate.staticFirst && !context.envValid) return null
  return staticAsset(gated ?? request, context.env.ASSETS)
}

/**
 * 命中的静态资源（预渲染页面、构建产物）；未命中返回 null。
 * WebSocket 升级（agents 插件的 /agents/*）不查静态资源：本地 dev 中 ASSETS 是 Vite 的 Node 服务，
 * 收到升级请求会让 miniflare 断言失败并退出 dev 进程。
 */
export async function staticAsset(
  request: Request,
  assets: Cloudflare.Env['ASSETS'] | undefined,
): Promise<Response | null> {
  if (!assets || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return null
  const asset = await assets.fetch(request)
  if (asset.status !== 404) return asset
  await asset.body?.cancel()
  return null
}
