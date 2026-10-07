import { env } from 'cloudflare:workers'
import {
  createTestPaymentRuntime,
  listRefundablePayments,
  notifyRefundRequest,
  submitRefundRequest,
} from '@saas/billing'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withRealSession, withWorkspace } from '../../server/middleware.ts'
import { templateConfig } from '../../server/template-config.ts'
import { enqueueRefundOperations } from '../notifications/operations.ts'

const workspace = z.object({ slug: z.string().min(1).max(64) })
function options(db: Parameters<typeof listRefundablePayments>[0]['db']) {
  return {
    db,
    providers: createTestPaymentRuntime(env, templateConfig.billing.providers, { cache: env.CACHE })
      .providers,
    config: templateConfig.billing,
    notify: (notification: Parameters<typeof notifyRefundRequest>[1]) =>
      notifyRefundRequest(
        {
          db,
          queue: env.EMAIL_QUEUE,
          appName: templateConfig.app.name,
          supportEmail: templateConfig.app.supportEmail,
        },
        notification,
      ),
  }
}
export const getCustomerRefunds = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(workspace)
  .handler(async ({ context }) => {
    if (context.member.role !== 'owner') return null
    const payments = await listRefundablePayments(options(context.db), {
      userId: context.user.id,
      workspaceId: context.workspace.id,
    })
    return {
      contactEmail: context.user.email,
      windowDays: templateConfig.billing.refundWindowDays,
      payments: payments.slice(0, 100).map((p) => ({
        id: p.id,
        provider: p.provider,
        amount: p.amount,
        currency: p.currency,
        paidAt: p.paidAt,
        remainingRefundable: p.remainingRefundable,
      })),
    }
  })
export const requestCustomerRefund = createServerFn({ method: 'POST' })
  .middleware([withWorkspace, withRealSession])
  .inputValidator(
    workspace.extend({
      paymentId: z.uuid(),
      reason: z.string().trim().min(1).max(2000),
      contactEmail: z.email().max(254),
    }),
  )
  .handler(async ({ context, data }) => {
    try {
      if (context.workspaceReadOnly)
        throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })
      const request = await submitRefundRequest(options(context.db), {
        userId: context.user.id,
        workspaceId: context.workspace.id,
        paymentId: data.paymentId,
        reason: data.reason,
        contactEmail: data.contactEmail,
      })
      await enqueueRefundOperations(context.db, env.EVENTS_QUEUE, request)
      return { ok: true as const, id: request.id }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof AppError ? error.code : 'REFUND_UNAVAILABLE',
      }
    }
  })
