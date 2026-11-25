import { AppError } from '@saas/shared'
import { getPendingAction } from '@web/features/admin/confirmations/service.ts'
import { z } from 'zod'
import { defineAdminTool, toolResult } from './define.ts'

// confirmations.get（add-admin-step-up 决策 9）：agent 查询自己发起的待确认记录的状态与结果。
// 只能看到同一管理员的令牌发起的记录；不返回执行参数、展示内容与密钥。

export const confirmationsGet = defineAdminTool({
  name: 'confirmations.get',
  scope: 'admin:read',
  description:
    'Read the status (pending, done, failed, rejected, or expired), summary, and result of an action that needs administrator confirmation.',
  input: z.strictObject({ id: z.uuid() }),
  params: { id: 'confirmationId returned with needs_owner_confirm.' },
  async run(ctx, { id }) {
    const row = await getPendingAction(ctx.db, id)
    if (!row || row.requestedBy !== ctx.admin.id)
      throw new AppError('CONFIRMATION_NOT_FOUND', 'Confirmation not found', { status: 404 })
    return toolResult({
      id: row.id,
      tool: row.tool,
      status: row.status,
      summary: row.summary,
      result: row.result ?? null,
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      confirmUrl: new URL(`/admin/confirm/${row.id}`, ctx.appUrl).toString(),
    })
  },
})
