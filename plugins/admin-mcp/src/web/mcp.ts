import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import type { WebRuntime } from '@web/server/runtime.ts'
import { markAdminApiTokenUsed, verifyAdminApiToken } from './tokens.ts'
import { type AdminToolContext, registerAdminTool } from './tools/define.ts'
import { pingTool } from './tools/ping.ts'

const maxRequestBodySize = 256 * 1024
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }

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
  const server = new McpServer({ name: 'admin-mcp', version: '1.0.0' })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize,
  })
  registerAdminTool(server, ctx, pingTool)
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}

type McpRuntime = Pick<WebRuntime, 'db' | 'cache' | 'rateLimiter' | 'requestMeta'> & {
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
