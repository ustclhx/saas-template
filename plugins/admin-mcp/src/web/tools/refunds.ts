import { creditGrant, organization, payment, refundRequest } from '@saas/db'
import { AppError } from '@saas/shared'
import type { AdminTransaction } from '@web/features/admin/action.ts'
import { ConfirmationFailedError, STALE_TARGET } from '@web/features/admin/confirmations/service.ts'
import { requireFeature } from '@web/server/feature-gates.ts'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { defineAdminTool, dryRunDescription, toolResult } from './define.ts'

// refunds.review（add-admin-step-up 决策 9，D1）：AI 审核已有退款申请。通过与驳回都经令牌所属
// 管理员在后台确认后执行（驳回会给用户发邮件），执行复用 @saas/billing 的 reviewRefundRequest：
// 抢占待确认记录与退款决策同事务提交，之后的支付平台调用沿用现有退款流程的确认与重试。

const MAX_AMOUNT = 2_147_483_647

const input = z
  .strictObject({
    requestId: z.uuid(),
    decision: z.enum(['approve', 'reject']),
    approvedAmount: z.number().int().positive().max(MAX_AMOUNT).optional(),
    reviewNote: z.string().trim().max(2000).optional(),
    dryRun: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.decision === 'approve'
        ? true
        : value.approvedAmount === undefined && Boolean(value.reviewNote),
    'A rejection needs reviewNote and no approvedAmount.',
  )

type Input = z.output<typeof input>

async function resolveReview(tx: AdminTransaction, value: Input) {
  requireFeature('billing')
  const [row] = await tx
    .select({
      request: refundRequest,
      payment,
      workspace: { id: organization.id, name: organization.name },
    })
    // biome-ignore lint/plugin: Platform-admin refund review reads the explicitly requested refund across workspaces.
    .from(refundRequest)
    .innerJoin(
      payment,
      and(
        eq(payment.id, refundRequest.paymentId),
        eq(payment.workspaceId, refundRequest.workspaceId),
      ),
    )
    .innerJoin(organization, eq(organization.id, refundRequest.workspaceId))
    .where(eq(refundRequest.id, value.requestId))
  if (!row)
    throw new AppError('REFUND_REQUEST_NOT_FOUND', 'Refund request not found', { status: 404 })
  const { request, workspace } = row
  if (request.status !== 'pending')
    throw new AppError('REFUND_NOT_PENDING', 'Refund request was already reviewed', { status: 409 })
  const remaining = row.payment.amount - row.payment.refundedAmount
  let approvedAmount: number | null = null
  if (value.decision === 'approve') {
    approvedAmount = value.approvedAmount ?? remaining
    if (approvedAmount > remaining)
      throw new AppError('INVALID_REFUND_AMOUNT', 'Refund amount exceeds the remaining payment')
    if (row.payment.status === 'disputed')
      throw new AppError('PAYMENT_NOT_REFUNDABLE', 'Disputed payment cannot be approved', {
        status: 409,
      })
  }
  const batches = await tx
    .select({ id: creditGrant.id, amount: creditGrant.amount, remaining: creditGrant.remaining })
    // biome-ignore lint/plugin: Credit batches of the refund's own payment in its own workspace.
    .from(creditGrant)
    .where(
      and(
        eq(creditGrant.workspaceId, request.workspaceId),
        eq(creditGrant.paymentId, row.payment.id),
      ),
    )
  const amountText = `${approvedAmount} ${row.payment.currency.toUpperCase()}`
  const summary =
    value.decision === 'approve'
      ? `Approve refund request ${request.id} for ${amountText} (workspace ${workspace.name}, ${workspace.id})`
      : `Reject refund request ${request.id} (workspace ${workspace.name}, ${workspace.id}). Note: ${value.reviewNote}`
  return {
    request,
    refundedAmount: row.payment.refundedAmount,
    approvedAmount,
    summary,
    display: {
      kind: 'refund',
      requestId: request.id,
      workspace,
      payment: {
        id: row.payment.id,
        provider: row.payment.provider,
        amount: row.payment.amount,
        refundedAmount: row.payment.refundedAmount,
        currency: row.payment.currency,
      },
      requestedAmount: request.requestedAmount,
      decision: value.decision,
      approvedAmount,
      reviewNote: value.reviewNote ?? '',
      credits: batches.map((batch) => ({ ...batch, used: batch.amount - batch.remaining })),
    },
  }
}

const payloadSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(['approve', 'reject']),
  approvedAmount: z.number().int().positive().nullable(),
  reviewNote: z.string(),
  refundedAmount: z.number().int(),
})

export const refundsReview = defineAdminTool({
  name: 'refunds.review',
  scope: 'admin:write',
  description:
    'Request a decision on a pending refund request: approve (full or partial) or reject. The decision runs only after the token owner confirms it in the admin console; the result is needs_owner_confirm with a confirmation link.',
  input,
  params: {
    requestId: 'Pending refund request ID.',
    decision: 'approve or reject.',
    approvedAmount:
      'Amount to refund in the smallest currency unit when approving. Defaults to the remaining refundable amount.',
    reviewNote: 'Review note shown to the customer. Required when rejecting.',
    dryRun: dryRunDescription,
  },
  adminAction: ({ decision }) => ({ name: 'billing.refund_review', input: { decision } }),
  // 驳回同样通知用户：通过与驳回都经确认（D1），run 只处理预览
  alwaysConfirm: true,
  async run(ctx, value) {
    const { summary, display } = await resolveReview(ctx.tx, value)
    return toolResult({ dryRun: true, summary, display })
  },
  async confirm(ctx, value) {
    const { request, refundedAmount, approvedAmount, summary, display } = await resolveReview(
      ctx.tx,
      value,
    )
    return {
      summary,
      display,
      payload: {
        requestId: request.id,
        decision: value.decision,
        approvedAmount,
        reviewNote: value.reviewNote ?? '',
        refundedAmount,
      },
    }
  },
  execute: () => ({
    kind: 'delegated',
    async run(db, { record, confirmation, auditMeta, ip }, decide) {
      requireFeature('billing')
      const saved = payloadSchema.parse(record.payload)
      // 支付运行时依赖 web 请求环境，只在后台确认执行时加载（MCP 端点与测试不引入）
      const { reviewAdminRefundRequest } = await import(
        '@web/features/billing/admin-refunds.server.ts'
      )
      const reviewed = await reviewAdminRefundRequest(db, {
        userId: confirmation.confirmedBy,
        ip,
        requestId: saved.requestId,
        decision: saved.decision,
        reviewNote: saved.reviewNote,
        ...(saved.approvedAmount === null ? {} : { approvedAmount: saved.approvedAmount }),
        auditMeta,
        inDecision: async (tx, locked) => {
          if (
            locked.request.status !== 'pending' ||
            locked.paid.refundedAmount !== saved.refundedAmount
          )
            throw new ConfirmationFailedError(
              STALE_TARGET,
              'The refund request changed after the request',
            )
          await decide(tx)
        },
      })
      return { refundRequestId: reviewed.id, status: reviewed.status }
    },
  }),
})
