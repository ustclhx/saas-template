import { env } from 'cloudflare:workers'
import {
  createBillingEventHandler,
  createCompensationFailureHandler,
  createTestPaymentRuntime,
  markManualRefund,
  notifyRefundRequest,
  type RefundServiceOptions,
  replayWebhook,
  retryRefundNotification,
  reviewRefundRequest,
} from '@saas/billing'
import { EnvValidationError } from '@saas/config'
import {
  creditGrant,
  type Database,
  payment,
  refundRequest,
  subscription,
  webhookEvent,
} from '@saas/db'
import { AppError } from '@saas/shared'
import { isNotFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import { withAdminAction, withDelegatedAdminAction } from '../admin/action.server.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'

const page = z.object({ offset: z.number().int().min(0).max(100_000).default(0) })
const request = z.object({ requestId: z.uuid() })
const eventsEnv = env as typeof env & { EVENTS_QUEUE?: Queue<{ v: 1; deliveryId: string }> }
function runtime() {
  try {
    return createTestPaymentRuntime(env, templateConfig.billing.providers, { cache: env.CACHE })
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error
    return {
      providers: {},
      normalizers: {},
      readiness: templateConfig.billing.providers.map((id) => ({ id, available: false })),
    } as ReturnType<typeof createTestPaymentRuntime>
  }
}
function refundOptions(db: Database): RefundServiceOptions {
  return {
    db,
    providers: runtime().providers,
    config: templateConfig.billing,
    notify: (notification) =>
      notifyRefundRequest(
        {
          db,
          queue: {
            send: async (message, options) => {
              await env.EMAIL_QUEUE.send(message, options)
            },
          },
          appName: templateConfig.app.name,
          supportEmail: templateConfig.app.supportEmail,
        },
        notification,
      ),
  }
}
async function safe(action: () => Promise<string>) {
  try {
    return { ok: true as const, status: await action() }
  } catch (error) {
    // 写事务内发现管理员已失效：与守卫一样返回 404，不当作业务失败
    if (isNotFound(error)) throw error
    return {
      ok: false as const,
      error: error instanceof AppError ? error.code : 'BILLING_UNAVAILABLE',
    }
  }
}

export const getAdminBilling = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(page)
  .handler(async ({ context, data }) => {
    const db = context.db
    const [payments, subscriptions, webhooks] = await Promise.all([
      db
        .select({
          id: payment.id,
          workspaceId: payment.workspaceId,
          provider: payment.provider,
          amount: payment.amount,
          refundedAmount: payment.refundedAmount,
          currency: payment.currency,
          status: payment.status,
        })
        // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads.
        .from(payment)
        .orderBy(desc(payment.createdAt), desc(payment.id))
        .limit(50)
        .offset(data.offset),
      db
        .select({
          id: subscription.id,
          workspaceId: subscription.workspaceId,
          provider: subscription.provider,
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        })
        // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads.
        .from(subscription)
        .orderBy(desc(subscription.createdAt), desc(subscription.id))
        .limit(50)
        .offset(data.offset),
      db
        .select({
          id: webhookEvent.id,
          provider: webhookEvent.provider,
          providerEventId: webhookEvent.providerEventId,
          type: webhookEvent.type,
          status: webhookEvent.status,
          attempts: webhookEvent.attempts,
        })
        .from(webhookEvent)
        .orderBy(desc(webhookEvent.receivedAt), desc(webhookEvent.id))
        .limit(50)
        .offset(data.offset),
    ])
    const current = runtime()
    return {
      payments,
      subscriptions,
      webhooks: webhooks.map((row) => ({
        ...row,
        replayAvailable: Boolean(current.normalizers[row.provider]),
      })),
      readiness: current.readiness,
      hasMore: [payments, subscriptions, webhooks].some((rows) => rows.length === 50),
    }
  })

export const getAdminRefunds = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(page)
  .handler(async ({ context, data }) => {
    const rows = await context.db
      .select({
        id: refundRequest.id,
        workspaceId: refundRequest.workspaceId,
        reason: refundRequest.reason,
        requestedAmount: refundRequest.requestedAmount,
        approvedAmount: refundRequest.approvedAmount,
        status: refundRequest.status,
        reviewNote: refundRequest.reviewNote,
        reviewerId: refundRequest.reviewerId,
        providerRefundId: refundRequest.providerRefundId,
        paymentId: payment.id,
        provider: payment.provider,
        currency: payment.currency,
        paymentAmount: payment.amount,
        refundedAmount: payment.refundedAmount,
      })
      // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads.
      .from(refundRequest)
      .innerJoin(payment, eq(payment.id, refundRequest.paymentId))
      .orderBy(desc(refundRequest.createdAt), desc(refundRequest.id))
      .limit(50)
      .offset(data.offset)
    const totals = rows.length
      ? await context.db
          .select({
            paymentId: creditGrant.paymentId,
            original: sql<number>`coalesce(sum(${creditGrant.amount}),0)::int`,
            remaining: sql<number>`coalesce(sum(${creditGrant.remaining}),0)::int`,
          })
          // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads.
          .from(creditGrant)
          .where(
            inArray(
              creditGrant.paymentId,
              rows.map((row) => row.paymentId),
            ),
          )
          .groupBy(creditGrant.paymentId)
      : []
    const providers = runtime().providers
    return {
      rows: rows.map((row) => ({
        ...row,
        remainingRefundable: row.paymentAmount - row.refundedAmount,
        originalCredits: totals.find((total) => total.paymentId === row.paymentId)?.original ?? 0,
        remainingCredits: totals.find((total) => total.paymentId === row.paymentId)?.remaining ?? 0,
        providerAvailable: Boolean(providers[row.provider]),
        manualAvailable: Boolean(
          providers[row.provider] && !providers[row.provider]?.capabilities.refundsViaApi,
        ),
      })),
      hasMore: rows.length === 50,
    }
  })

export const replayAdminWebhook = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ webhookEventId: z.uuid() }))
  .handler(({ context, data }) =>
    safe(async () => {
      const current = runtime()
      // 校验与「已请求重放」审计同事务提交；重放本身在提交后执行（自行管理事务与队列通知），
      // 重放失败记录在回调事件上，可再次重试
      const delivery = await withAdminAction(
        context,
        'billing.webhook_replay',
        async ({ tx, audit }) => {
          const [found] = await tx
            .select({ provider: webhookEvent.provider, status: webhookEvent.status })
            .from(webhookEvent)
            .where(eq(webhookEvent.id, data.webhookEventId))
          if (found?.status !== 'failed')
            throw new AppError('WEBHOOK_NOT_REPLAYABLE', 'Only failed records can be replayed')
          if (!current.normalizers[found.provider])
            throw new AppError('BILLING_PROVIDER_UNAVAILABLE', 'Provider unavailable')
          await audit({
            action: 'billing.webhook_replay_requested',
            targetType: 'webhook_event',
            targetId: data.webhookEventId,
          })
          return found
        },
      )
      const normalize = current.normalizers[delivery.provider]
      if (!normalize) throw new AppError('BILLING_PROVIDER_UNAVAILABLE', 'Provider unavailable')
      const result = await replayWebhook({
        db: context.db,
        webhookEventId: data.webhookEventId,
        providerId: delivery.provider,
        normalize,
        ...createBillingEventHandler({
          db: context.db,
          providers: current.providers,
          subscriptionCreditGraceHours: templateConfig.billing.subscriptionCreditGraceHours,
        }),
        onFailure: createCompensationFailureHandler(context.db),
        notify: async ({ delivery }) => {
          if (!eventsEnv.EVENTS_QUEUE) throw new Error('Events queue unavailable')
          await eventsEnv.EVENTS_QUEUE.send(
            { v: 1, deliveryId: delivery.id },
            { contentType: 'json' },
          )
        },
      })
      return result.status === 'failed'
        ? 'Replay failed; record remains available for retry.'
        : 'notification' in result && result.notification.status === 'failed'
          ? `${result.status}; notification queue failed`
          : result.status
    }),
  )

// 退款审核 / 手动退款 / 重发通知：@saas/billing 在自己的决策事务内写审计，并在提交后才调用支付平台与邮件队列，
// 因此只经 adminAction 的实时角色校验（withDelegatedAdminAction），不包进外层事务
export const reviewAdminRefund = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(
    request.extend({
      decision: z.enum(['approve', 'reject']),
      approvedAmount: z.number().int().positive().max(2_147_483_647).optional(),
      reviewNote: z.string().trim().max(2000),
    }),
  )
  .handler(({ context, data }) =>
    safe(async () =>
      withDelegatedAdminAction(
        context,
        async (db) =>
          (
            await reviewRefundRequest(refundOptions(db), {
              requestId: data.requestId,
              decision: data.decision,
              reviewNote: data.reviewNote,
              ...(data.approvedAmount === undefined ? {} : { approvedAmount: data.approvedAmount }),
              userId: context.admin.id,
            })
          ).status,
      ),
    ),
  )

export const completeAdminRefund = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(
    request.extend({
      providerRefundId: z.string().trim().min(1).max(2000),
      proof: z.string().trim().min(1).max(2000),
    }),
  )
  .handler(({ context, data }) =>
    safe(async () =>
      withDelegatedAdminAction(
        context,
        async (db) =>
          (await markManualRefund(refundOptions(db), { ...data, userId: context.admin.id })).status,
      ),
    ),
  )

export const retryAdminRefundEmail = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(request)
  .handler(({ context, data }) =>
    safe(async () =>
      withDelegatedAdminAction(context, async (db) => {
        await retryRefundNotification(refundOptions(db), { ...data, userId: context.admin.id })
        return 'Email queued or already delivered'
      }),
    ),
  )
