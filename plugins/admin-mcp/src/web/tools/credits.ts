import { creditGrant, organization } from '@saas/db'
import { AppError, newId } from '@saas/shared'
import type { AdminTransaction } from '@web/features/admin/action.ts'
import { ConfirmationFailedError, STALE_TARGET } from '@web/features/admin/confirmations/service.ts'
import {
  adjustAdminCredits,
  adminCreditBalance,
  creditAdjustmentInput,
} from '@web/features/admin/credits.ts'
import { requireFeature } from '@web/server/feature-gates.ts'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { defineAdminTool, dryRunDescription, toolResult } from './define.ts'

// credits.adjust（add-admin-step-up 决策 9，D1）：AI 发起空间积分增加或收回批次，
// 一律经令牌所属管理员在后台确认后执行，执行复用后台的 adjustAdminCredits。

const MAX_AMOUNT = 2_147_483_647

const input = z
  .strictObject({
    workspace: z.string().trim().min(1).max(200),
    kind: z.enum(['grant', 'revoke']),
    amount: z.number().int().positive().max(MAX_AMOUNT).optional(),
    expiresAt: z.iso.datetime().optional(),
    grantId: z.uuid().optional(),
    reason: z.string().trim().min(1).max(2000),
    dryRun: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.kind === 'grant'
        ? value.amount !== undefined && value.grantId === undefined
        : value.grantId !== undefined &&
          value.amount === undefined &&
          value.expiresAt === undefined,
    'A grant needs amount (and optionally expiresAt); a revoke needs grantId only.',
  )

type Input = z.output<typeof input>

async function findWorkspace(tx: AdminTransaction, workspace: string) {
  const byId = z.uuid().safeParse(workspace).success
  const [row] = await tx
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .where(
      and(
        byId ? eq(organization.id, workspace) : eq(organization.slug, workspace),
        // 已删除的空间不接受调整
        isNull(organization.deletedAt),
      ),
    )
  return row
}

async function findGrant(
  tx: AdminTransaction,
  workspaceId: string,
  grantId: string,
  lock: boolean,
) {
  const query = tx
    .select({
      id: creditGrant.id,
      amount: creditGrant.amount,
      remaining: creditGrant.remaining,
      status: creditGrant.status,
      source: creditGrant.source,
      expiresAt: creditGrant.expiresAt,
    })
    // biome-ignore lint/plugin: Platform-admin credit adjustment reads the batch of the explicitly resolved workspace.
    .from(creditGrant)
    .where(and(eq(creditGrant.id, grantId), eq(creditGrant.workspaceId, workspaceId)))
  const [grant] = lock ? await query.for('update') : await query
  return grant
}

/** 解析 AI 传入的空间标识与批次，读出快照；同一逻辑用于预览与创建待确认记录 */
async function resolveAdjustment(tx: AdminTransaction, value: Input) {
  requireFeature('credits')
  const workspace = await findWorkspace(tx, value.workspace)
  if (!workspace) throw new AppError('WORKSPACE_NOT_FOUND', 'Workspace not found', { status: 404 })
  // 发起时的可用余额，只作展示：确认页以打开时的实时余额计算「当前 → 执行后」并注明发起时余额；
  // 执行不比对余额（调整是增量，余额随扣费变化属正常）
  const balance = await adminCreditBalance(tx, workspace.id)
  if (value.kind === 'grant') {
    const amount = value.amount ?? 0
    const expires = value.expiresAt ? `, expiring ${value.expiresAt}` : ''
    return {
      workspace,
      grant: undefined,
      summary: `Grant ${amount} credits to workspace ${workspace.name} (${workspace.id})${expires}. Reason: ${value.reason}`,
      display: {
        kind: 'credits',
        operation: 'grant',
        workspace,
        amount,
        expiresAt: value.expiresAt ?? null,
        reason: value.reason,
        balance: { before: balance, after: balance + amount },
      },
    }
  }
  const grant = await findGrant(tx, workspace.id, value.grantId ?? '', false)
  if (!grant) throw new AppError('GRANT_NOT_FOUND', 'Credit batch not found', { status: 404 })
  if (grant.status !== 'active')
    throw new AppError('GRANT_NOT_ACTIVE', 'Credit batch is not active', { status: 409 })
  // 已过期的批次不计入可用余额，收回它不改变余额
  const counted = grant.expiresAt === null || grant.expiresAt.getTime() > Date.now()
  return {
    workspace,
    grant,
    summary: `Revoke credit batch ${grant.id} (${grant.remaining} of ${grant.amount} remaining) from workspace ${workspace.name} (${workspace.id}). Reason: ${value.reason}`,
    display: {
      kind: 'credits',
      operation: 'revoke',
      workspace,
      grant: { id: grant.id, amount: grant.amount, remaining: grant.remaining },
      reason: value.reason,
      balance: { before: balance, after: counted ? balance - grant.remaining : balance },
    },
  }
}

const payloadSchema = z.object({
  adjustment: creditAdjustmentInput,
  grant: z.object({ remaining: z.number(), status: z.string() }).nullable(),
})

export const creditsAdjust = defineAdminTool({
  name: 'credits.adjust',
  scope: 'admin:write',
  description:
    'Request a workspace credit adjustment: grant credits or revoke an active credit batch. The change runs only after the token owner confirms it in the admin console; the result is needs_owner_confirm with a confirmation link.',
  input,
  params: {
    workspace: 'Workspace ID or slug.',
    kind: 'grant to add credits, or revoke to cancel the remaining credits of a batch.',
    amount: 'Credits to grant (positive integer). Required for grant.',
    expiresAt: 'Optional ISO 8601 expiry for granted credits. Omit for credits that never expire.',
    grantId: 'Credit batch ID to revoke (from credits.grants). Required for revoke.',
    reason: 'Reason recorded in the audit log (1–2000 characters).',
    dryRun: dryRunDescription,
  },
  adminAction: () => 'credits.adjust',
  // 积分调整始终敏感：非预览调用都会转为待确认，run 只处理预览
  async run(ctx, value) {
    const { summary, display } = await resolveAdjustment(ctx.tx, value)
    return toolResult({ dryRun: true, summary, display })
  },
  async confirm(ctx, value) {
    const { workspace, grant, summary, display } = await resolveAdjustment(ctx.tx, value)
    // 确认时生成调整 ID：重复确认请求由 adjustAdminCredits 按 ID 幂等处理
    const adjustmentId = newId()
    const adjustment =
      value.kind === 'grant'
        ? {
            kind: 'grant' as const,
            adjustmentId,
            workspaceId: workspace.id,
            amount: value.amount ?? 0,
            expiresAt: value.expiresAt ?? null,
            reason: value.reason,
          }
        : {
            kind: 'revoke' as const,
            adjustmentId,
            workspaceId: workspace.id,
            grantId: value.grantId ?? '',
            reason: value.reason,
          }
    return {
      summary,
      display: { ...display, adjustmentId },
      payload: {
        adjustment,
        grant: grant ? { remaining: grant.remaining, status: grant.status } : null,
      },
    }
  },
  execute: () => ({
    kind: 'transaction',
    async run(scope, { record }) {
      requireFeature('credits')
      const { adjustment, grant } = payloadSchema.parse(record.payload)
      if (adjustment.kind === 'revoke') {
        const current = await findGrant(scope.tx, adjustment.workspaceId, adjustment.grantId, true)
        if (!current || current.remaining !== grant?.remaining || current.status !== grant.status)
          throw new ConfirmationFailedError(
            STALE_TARGET,
            'The credit batch changed after the request',
          )
      }
      const { replayed } = await adjustAdminCredits(scope, adjustment)
      return {
        adjustmentId: adjustment.adjustmentId,
        workspaceId: adjustment.workspaceId,
        kind: adjustment.kind,
        replayed,
      }
    },
  }),
})
