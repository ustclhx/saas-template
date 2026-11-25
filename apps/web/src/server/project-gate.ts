// 项目自有：模板只创建本文件，之后不再修改（template-release 检查），template-sync 不会在这里冲突。
// Worker 入口（server.ts）在「预渲染静态资源先发」之前调用 gateProjectRequest，环境校验失败时同样先调用。
// 适合放必须早于静态页生效的项目规则，例如多站点按 Host 选预渲染目录、非本站语言前缀返回 404、
// 默认语言前缀 301 到无前缀。返回值：
//   - Response：直接作为响应返回（按静态响应补安全头，HTML 按内联脚本哈希补 CSP），不再查静态资源与运行时；
//   - Request：只用于查找静态资源的改写请求（例如把 /about 改为 /sites/b.example/about）；
//     未命中时动态流程仍使用原始请求；
//   - undefined：不处理，沿用模板流程。
// 钩子运行在环境校验与运行时（数据库、认证）之前，只能使用 env 中的静态绑定（如 ASSETS），不要查库。
// 例如：
//
//   export function gateProjectRequest(request: Request, { env }: ProjectGateContext) {
//     const url = new URL(request.url)
//     if (url.hostname === 'b.example' && env.ASSETS) {
//       url.pathname = `/sites/b${url.pathname}`
//       return new Request(url, request)
//     }
//   }
import type { ProjectGateContext, ProjectGateResult } from './cloudflare/assets.ts'

/**
 * 命中的预渲染静态资源是否先于环境校验返回（public-site-availability）。
 * 改为 false 时沿用 0.9.0 及以前的行为：环境校验失败时所有请求（含静态页）返回 500，
 * 校验通过后静态资源仍先于 TanStack Start 返回。
 */
export const staticFirst: boolean = true

export function gateProjectRequest(
  _request: Request,
  _context: ProjectGateContext,
): ProjectGateResult | Promise<ProjectGateResult> {
  return undefined
}
