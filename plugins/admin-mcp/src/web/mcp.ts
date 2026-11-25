import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { isAiFaultInjectionEnabled } from '@saas/config'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import type { WebRuntime } from '@web/server/runtime.ts'
import { markAdminApiTokenUsed, verifyAdminApiToken } from './tokens.ts'
import { businessTools } from './tools/business.ts'
import { type AdminToolContext, rejectUnknownAdminTool } from './tools/define.ts'
import { modelTools } from './tools/models.ts'
import { pingTool } from './tools/ping.ts'
import { settingTools } from './tools/settings.ts'

const maxRequestBodySize = 256 * 1024
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }

export const adminTools = [pingTool, ...settingTools, ...modelTools, ...businessTools] as const

function mcpError(status: number, message: string, headers?: Record<string, string>) {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: status >= 500 ? -32603 : -32000, message } },
    { status, headers: { ...responseHeaders, ...headers } },
  )
}

function unauthorized() {
  return mcpError(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
}

async function dispatch(request: Request, ctx: AdminToolContext) {
  // 先接管 tools/call，再做工具级校验，才能记录 SDK 默认会提前拒绝的调用。
  const server = new Server(
    { name: 'admin-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  const tools = adminTools.map((tool) => tool.register(ctx))
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]))
  server.setRequestHandler('tools/list', () => ({ tools: tools.map((tool) => tool.spec) }))
  server.setRequestHandler('tools/call', async ({ params }) => {
    const tool = byName.get(params.name)
    const result = tool
      ? await tool.call(params.arguments ?? {})
      : await rejectUnknownAdminTool(ctx, params.name)
    return server.projectCallToolResult(result, undefined)
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}

type McpRuntime = Pick<WebRuntime, 'db' | 'cache' | 'rateLimiter' | 'requestMeta' | 'ai'> & {
  readonly config: Pick<WebRuntime['config'], 'APP_URL'>
}

export async function respondToAdminMcp(
  request: Request,
  getRuntime: () => McpRuntime,
): Promise<Response> {
  if (request.method !== 'POST') return mcpError(405, 'Method not allowed', { Allow: 'POST' })
  try {
    const runtime = getRuntime()
    // CLI 可以省略 Origin。浏览器来源以部署配置为准，避免使用请求中的 Host 自证。
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== new URL(runtime.config.APP_URL).origin)
      return mcpError(403, 'Forbidden origin')
    const bearer = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!bearer) return unauthorized()

    const { db, rateLimiter, cache, requestMeta } = runtime
    const token = await verifyAdminApiToken(db, bearer)
    if (!token) return unauthorized()

    const { success } = await rateLimiter.limit('admin-mcp', token.id)
    if (!success) return mcpError(429, 'Too many requests')

    const response = await dispatch(request, {
      db,
      admin: { id: token.adminId },
      token: { id: token.id, scopes: token.scopes },
      cache,
      requestMetadata: requestMeta,
      ip: requestMeta.clientIp,
      workersAiAvailable: runtime.ai?.available === true && runtime.ai.value.workersAi.available,
      aiFaultInjectionEnabled: isAiFaultInjectionEnabled(
        runtime.ai?.available === true ? runtime.ai.value.config : {},
      ),
    })
    if (response.ok) {
      // 工具可能已提交业务写入，辅助使用时间写入失败时仍返回工具结果。
      try {
        await markAdminApiTokenUsed(db, token)
      } catch {
        log.warn('admin.mcp.last_used_update_failed', { tokenId: token.id })
      }
    }
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(responseHeaders)) headers.set(name, value)
    return new Response(response.body, { status: response.status, headers })
  } catch (error) {
    // 数据库和 SDK 的异常可能含 SQL 或凭据，响应和日志只保留固定错误。
    log.error('admin.mcp.request_failed')
    if (error instanceof AppError && error.status === 503)
      return mcpError(503, 'Service unavailable')
    return mcpError(500, 'Internal server error')
  }
}
