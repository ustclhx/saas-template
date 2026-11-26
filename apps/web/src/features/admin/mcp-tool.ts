import type { KeyValueStore, RequestMetadata } from '@saas/platform'
import type { z } from 'zod'
import type { AdminActionContext, AdminActionScope } from './action.ts'
import type { AdminActionRef } from './actions.registry.ts'
import type { ConfirmationExecutor, ConfirmationRequest } from './confirmations/service.ts'

export type AdminMcpScope = 'admin:read' | 'admin:write'

export interface AdminToolContext extends AdminActionContext {
  readonly token: { readonly id: string; readonly scopes: readonly AdminMcpScope[] }
  readonly cache: KeyValueStore
  readonly requestMetadata: RequestMetadata
  readonly workersAiAvailable: boolean
  readonly aiFaultInjectionEnabled: boolean
  readonly appUrl: string
}

export interface ToolExecutionEnv {
  readonly cache: KeyValueStore
  readonly workersAiAvailable: boolean
  readonly aiFaultInjectionEnabled: boolean
}

export const dryRunDescription =
  'Set to true to preview and validate the change without saving. Defaults to false.'

export function toolResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  }
}

type ToolHandler<Schema extends z.ZodObject, Context, Result> = (
  ctx: Context,
  input: z.output<Schema>,
) => Result | Promise<Result>

type WriteContext = AdminToolContext &
  AdminActionScope & {
    readonly dryRun: boolean
    /** 回调只在正式写入与审计均已提交后运行。 */
    afterCommit(callback: () => void | Promise<void>): void
  }

export type AdminToolDefinition<Schema extends z.ZodObject, Result> = {
  readonly description: string
  readonly input: Schema
  readonly params: { readonly [Key in keyof NoInfer<Schema>['shape']]: string }
} & (
  | { readonly scope: 'admin:read'; run: ToolHandler<Schema, AdminToolContext, Result> }
  | {
      readonly scope: 'admin:write'
      /** 复用已登记的后台动作与敏感判定。 */
      adminAction(input: z.output<Schema>): AdminActionRef
      run: ToolHandler<Schema, WriteContext, Result>
      /** 命中敏感判定时保存已解析的目标、快照与确认执行参数。 */
      confirm?(
        ctx: AdminToolContext & AdminActionScope,
        input: z.output<Schema>,
      ): Promise<ConfirmationRequest>
      /** 后台确认后只使用保存的参数执行。 */
      execute?(env: ToolExecutionEnv): ConfirmationExecutor
      alwaysConfirm?: boolean
    }
)

export type AdminMcpToolFactory = <Registered>(
  register: <Schema extends z.ZodObject>(
    tool: AdminToolDefinition<Schema, ReturnType<typeof toolResult>>,
  ) => Registered,
) => Registered

/** 插件只声明业务，注册、协议和授权由启用的 admin-mcp 统一处理。 */
export function definePluginAdminMcpTool<Schema extends z.ZodObject>(
  definition: AdminToolDefinition<Schema, ReturnType<typeof toolResult>>,
): AdminMcpToolFactory {
  return (register) => register<Schema>(definition)
}
