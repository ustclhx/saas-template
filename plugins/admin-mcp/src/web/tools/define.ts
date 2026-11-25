import type { CallToolResult, Tool } from '@modelcontextprotocol/server'
import { getSettingDefinition } from '@saas/db'
import type { KeyValueStore, RequestMetadata } from '@saas/platform'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import {
  AdminAccessRevokedError,
  type AdminActionContext,
  type AdminActionScope,
  type AdminAuditEntry,
  runAdminAction,
} from '@web/features/admin/action.ts'
import type { AdminActionRef } from '@web/features/admin/actions.registry.ts'
import { ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { z } from 'zod'
import { adminMcpActions } from '../actions.ts'
import type { AdminTokenScope } from '../tokens.ts'

export interface AdminToolContext extends AdminActionContext {
  readonly token: { readonly id: string; readonly scopes: readonly AdminTokenScope[] }
  readonly cache: KeyValueStore
  readonly requestMetadata: RequestMetadata
  readonly workersAiAvailable: boolean
  readonly aiFaultInjectionEnabled: boolean
}

type ToolSuccess = CallToolResult & { isError?: false }

export const pagingDescriptions = {
  offset: 'Number of matching records to skip. Defaults to 0.',
  limit: `Maximum number of records to return. Defaults to ${ADMIN_PAGE_SIZE}, the page limit.`,
}

export const dryRunDescription =
  'Set to true to preview and validate the change without saving. Defaults to false.'

type ToolHandler<Schema extends z.ZodObject, Context> = (
  ctx: Context,
  input: z.output<Schema>,
) => ToolSuccess | Promise<ToolSuccess>

type AdminTool<Schema extends z.ZodObject> = {
  readonly name: string
  readonly description: string
  readonly input: Schema
  readonly params: { readonly [Key in keyof NoInfer<Schema>['shape']]: string }
} & (
  | { readonly scope: 'admin:read'; run: ToolHandler<Schema, AdminToolContext> }
  | {
      readonly scope: 'admin:write'
      /**
       * 本次写入对应的后台动作（与后台同名，见 actions.registry.ts），按已校验的输入给出。
       * 敏感判定命中时，无会话的 MCP 调用被拒（STEP_UP_REQUIRED）；改为待确认由第 3 组实现。
       */
      adminAction(input: z.output<Schema>): AdminActionRef
      run: ToolHandler<Schema, AdminToolContext & AdminActionScope & { dryRun: boolean }>
      afterCommit?(ctx: AdminToolContext, input: z.output<Schema>): Promise<void>
    }
)

export function defineAdminTool<Schema extends z.ZodObject>(tool: AdminTool<Schema>) {
  // 在导出的对象上写说明，避免改动后台页面复用的 Zod schema。
  const inputSchema = z.toJSONSchema(tool.input, { io: 'input' })
  const properties = inputSchema.properties
  if (properties) {
    for (const [key, property] of Object.entries(properties)) {
      const schema = typeof property === 'object' ? property : property ? {} : { not: {} }
      const param = key as keyof Schema['shape']
      properties[key] = {
        ...schema,
        description: tool.params[param],
      }
    }
  }

  const spec: Tool = {
    name: tool.name,
    description: tool.description,
    // ZodObject 生成对象 schema，SDK 的类型要求显式声明根类型。
    inputSchema: inputSchema as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.scope === 'admin:read' },
  }
  return {
    spec,
    scope: tool.scope,
    register: (ctx: AdminToolContext) => registerAdminTool(ctx, tool, spec),
  }
}

export function toolResult(data: Record<string, unknown>): ToolSuccess {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function toolError(code: string, message: string): CallToolResult {
  return {
    ...toolResult({ error: { code, message } }),
    isError: true,
  }
}

type Scalar = string | number | boolean | null

function summarizeArguments(
  name: string,
  keys: string[],
  input: Record<string, unknown>,
): Record<string, Scalar> {
  const entries: [string, Scalar][] = []
  const secretSetting =
    name === 'settings.set' &&
    typeof input.key === 'string' &&
    getSettingDefinition(input.key)?.secret === true

  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (secretSetting && key === 'value') entries.push([key, '[redacted]'])
    else if (typeof value === 'string') entries.push([key, value.slice(0, 200)])
    else if (typeof value === 'boolean' || typeof value === 'number' || value === null)
      entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

function mapToolError(error: unknown) {
  if (error instanceof AdminAccessRevokedError)
    return { code: 'ADMIN_ACCESS_REVOKED', message: 'Admin access revoked' }
  if (error instanceof AppError && error.expose && error.status < 500)
    return { code: error.code, message: error.message }
  return { code: 'INTERNAL_ERROR', message: 'Tool execution failed' }
}

type CallMeta = {
  via: 'mcp'
  tokenId: string
  tool: string
  params: Record<string, Scalar>
  dryRun?: true
}

function callAuditEntry(meta: CallMeta, result: string): AdminAuditEntry {
  return {
    action: 'admin.mcp.call',
    targetType: 'admin_api_token',
    targetId: meta.tokenId,
    meta: { ...meta, result },
  }
}

async function finishCall(
  ctx: AdminToolContext,
  meta: CallMeta,
  result: CallToolResult,
  code: string,
) {
  try {
    await runAdminAction(ctx, adminMcpActions['admin.mcp.call'], ({ audit }) =>
      audit(callAuditEntry(meta, code)),
    )
    return result
  } catch (error) {
    // 审计失败时禁止返回数据，日志不记录数据库异常内容。
    log.error('admin.mcp.audit_failed', { tokenId: ctx.token.id })
    const failure = mapToolError(error)
    return toolError(failure.code, failure.message)
  }
}

export function rejectUnknownAdminTool(ctx: AdminToolContext, name: string) {
  return finishCall(
    ctx,
    { via: 'mcp', tokenId: ctx.token.id, tool: name.slice(0, 200), params: {} },
    toolError('UNKNOWN_TOOL', 'Unknown admin tool'),
    'UNKNOWN_TOOL',
  )
}

export function registerAdminTool<Schema extends z.ZodObject>(
  ctx: AdminToolContext,
  tool: AdminTool<Schema>,
  spec: Tool,
) {
  const keys = Object.keys(tool.input.shape)
  return {
    spec,
    async call(input: Record<string, unknown>): Promise<CallToolResult> {
      const dryRun = tool.scope === 'admin:write' && input.dryRun === true
      const meta: CallMeta = {
        via: 'mcp',
        tokenId: ctx.token.id,
        tool: tool.name,
        params: summarizeArguments(tool.name, keys, input),
        ...(dryRun ? { dryRun: true } : {}),
      }

      try {
        if (!ctx.token.scopes.includes(tool.scope))
          throw new AppError('INSUFFICIENT_SCOPE', 'Insufficient token scope', { status: 403 })

        const parsed = tool.input.safeParse(input)
        if (!parsed.success) throw new AppError('INVALID_TOOL_ARGUMENTS', 'Invalid tool arguments')

        if (tool.scope === 'admin:read') {
          const result = await tool.run(ctx, parsed.data)
          return finishCall(ctx, meta, result, 'ok')
        }
        // 预览只校验不保存，不要求重新验证；正式写入按工具声明的后台动作判定
        const action = dryRun ? adminMcpActions['admin.mcp.dry_run'] : tool.adminAction(parsed.data)
        const result = await runAdminAction(ctx, action, async (scope) => {
          const preview = await tool.run(
            {
              ...ctx,
              ...scope,
              dryRun,
              audit: (entry) =>
                scope.audit({
                  ...entry,
                  meta: {
                    ...(typeof entry.meta === 'object' ? entry.meta : {}),
                    ...meta,
                    result: 'ok',
                  },
                }),
            },
            parsed.data,
          )
          if (dryRun) await scope.audit(callAuditEntry(meta, 'ok'))
          return preview
        })
        if (!dryRun && tool.afterCommit) {
          try {
            await tool.afterCommit(ctx, parsed.data)
          } catch {
            // 事务及业务审计已经提交，调用方可据错误码区分缓存刷新失败。
            log.error('admin.mcp.cache_invalidation_failed', {
              tool: tool.name,
              tokenId: ctx.token.id,
            })
            return toolError(
              'CACHE_INVALIDATION_FAILED',
              'Changes were saved, but cache refresh failed',
            )
          }
        }
        return result
      } catch (error) {
        const { code, message } = mapToolError(error)
        if (code === 'INTERNAL_ERROR') log.error('admin.mcp.tool_failed', { tool: tool.name })
        return finishCall(ctx, meta, toolError(code, message), code)
      }
    },
  }
}
