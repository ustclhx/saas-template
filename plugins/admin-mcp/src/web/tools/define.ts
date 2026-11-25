import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import type { Database } from '@saas/db'
import type { KeyValueStore, RequestMetadata } from '@saas/platform'
import { log } from '@saas/shared/log'
import type { z } from 'zod'
import type { AdminTokenScope } from '../tokens.ts'

export interface AdminToolContext {
  readonly db: Database
  readonly admin: { readonly id: string }
  readonly token: { readonly id: string; readonly scopes: readonly AdminTokenScope[] }
  readonly cache: KeyValueStore
  readonly requestMetadata: RequestMetadata
}

interface AdminTool<Schema extends z.ZodObject> {
  readonly name: string
  readonly scope: AdminTokenScope
  readonly description: string
  readonly input: Schema
  run(ctx: AdminToolContext, input: z.output<Schema>): CallToolResult | Promise<CallToolResult>
}

export function defineAdminTool<Schema extends z.ZodObject>(tool: AdminTool<Schema>) {
  return tool
}

export function registerAdminTool<Schema extends z.ZodObject>(
  server: McpServer,
  ctx: AdminToolContext,
  tool: AdminTool<Schema>,
) {
  server.registerTool<never, z.ZodObject>(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: tool.scope === 'admin:read' },
    },
    async (input): Promise<CallToolResult> => {
      if (!ctx.token.scopes.includes(tool.scope))
        return { isError: true, content: [{ type: 'text', text: 'Insufficient token scope' }] }
      try {
        // SDK 已用这个工具自己的 inputSchema 校验；注册时的通用类型抹去了具体 schema。
        return await tool.run(ctx, input as z.output<Schema>)
      } catch {
        log.error('admin.mcp.tool_failed', { tool: tool.name })
        return { isError: true, content: [{ type: 'text', text: 'Tool execution failed' }] }
      }
    },
  )
}
