import { env } from 'cloudflare:workers'
import {
  cancelSubscription,
  changePlan,
  confirmCheckout,
  createCheckout,
  createTestPaymentRuntime,
  getPortalUrl,
  resumeSubscription,
} from '@saas/billing'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withRealSession, withWorkspace } from '../../server/middleware.ts'
import { templateConfig } from '../../server/template-config.ts'
import {
  creditPageSchema,
  customerBilling,
  customerCatalog,
  customerUsage,
} from './customer-data.ts'

const workspace = z.object({ slug: z.string().min(1).max(64) })
const provider = z.enum(['stripe', 'paypal', 'creem', 'paddle', 'polar'])
function runtime(db: ReturnType<typeof createDb>) {
  return createTestPaymentRuntime(env, templateConfig.billing.providers, { cache: env.CACHE, db })
}
function service(db: ReturnType<typeof createDb>) {
  return {
    db,
    providers: runtime(db).providers,
    enabledProviders: templateConfig.billing.providers,
  }
}
function returnUrl(slug: string, id: string, canceled = false) {
  const url = new URL(`/app/${encodeURIComponent(slug)}/billing-return`, env.APP_URL)
  url.searchParams.set('provider', id)
  if (canceled) url.searchParams.set('canceled', 'true')
  return url.toString()
}
async function safe<T>(readOnly: boolean, action: () => Promise<T>) {
  try {
    if (readOnly)
      throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })
    return { ok: true as const, result: await action() }
  } catch (error) {
    // 非业务错误（服务商拒绝、网络等）对用户只显示 BILLING_UNAVAILABLE，原因需留在日志中排查
    if (!(error instanceof AppError)) log.error('billing.action_failed', { error })
    return {
      ok: false as const,
      error: error instanceof AppError ? error.code : 'BILLING_UNAVAILABLE',
    }
  }
}
export const getPublicPricing = createServerFn({ method: 'GET' }).handler(() => {
  const db = createDb(env.HYPERDRIVE)
  return customerCatalog(db, runtime(db).readiness)
})
export const getCustomerBilling = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(workspace)
  .handler(async ({ context }) => ({
    ...(await customerBilling(
      context.db,
      context.workspace.id,
      context.member.role,
      templateConfig.billing.pastDueGraceDays,
    )),
    catalog: await customerCatalog(context.db, runtime(context.db).readiness),
    role: context.member.role,
    readOnly: context.workspaceReadOnly,
  }))
export const getCustomerUsage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(
    workspace.extend({
      ...creditPageSchema.shape,
      kind: z.enum(['ledger', 'batches']).default('ledger'),
    }),
  )
  .handler(({ context, data }) =>
    customerUsage(
      context.db,
      context.workspace.id,
      context.user.id,
      context.member.role,
      { limit: data.limit, ...(data.cursor ? { cursor: data.cursor } : {}) },
      data.kind,
    ),
  )
export const checkoutCustomer = createServerFn({ method: 'POST' })
  .middleware([withWorkspace, withRealSession])
  .inputValidator(
    workspace.extend({
      provider,
      planPriceId: z.uuid(),
      idempotencyKey: z.uuid(),
      confirmSwitch: z.boolean().optional(),
      expectedOldSubscriptionId: z.uuid().optional(),
    }),
  )
  .handler(({ context, data }) =>
    safe(context.workspaceReadOnly, async () => {
      const result = await createCheckout(service(context.db), {
        ip: getRequest().headers.get('cf-connecting-ip'),
        provider: data.provider,
        planPriceId: data.planPriceId,
        idempotencyKey: data.idempotencyKey,
        ...(data.confirmSwitch === undefined ? {} : { confirmSwitch: data.confirmSwitch }),
        ...(data.expectedOldSubscriptionId
          ? { expectedOldSubscriptionId: data.expectedOldSubscriptionId }
          : {}),
        workspaceId: context.workspace.id,
        userId: context.user.id,
        successUrl: returnUrl(context.workspace.slug, data.provider),
        cancelUrl: returnUrl(context.workspace.slug, data.provider, true),
      })
      return { url: result.url }
    }),
  )
export const manageCustomerSubscription = createServerFn({ method: 'POST' })
  .middleware([withWorkspace, withRealSession])
  .inputValidator(
    workspace.extend({
      subscriptionId: z.uuid(),
      action: z.enum(['cancel', 'resume', 'portal', 'change']),
      planPriceId: z.uuid().optional(),
    }),
  )
  .handler(({ context, data }) =>
    safe(context.workspaceReadOnly, async () => {
      const ctx = service(context.db)
      const input = {
        ip: getRequest().headers.get('cf-connecting-ip'),
        subscriptionId: data.subscriptionId,
        workspaceId: context.workspace.id,
        userId: context.user.id,
      }
      if (data.action === 'portal')
        return {
          status: 'portal',
          url: await getPortalUrl(ctx, {
            ...input,
            returnUrl: new URL(
              `/app/${encodeURIComponent(context.workspace.slug)}/billing`,
              env.APP_URL,
            ).toString(),
          }),
        }
      if (data.action === 'change') {
        if (!data.planPriceId) throw new AppError('BILLING_PRICE_UNAVAILABLE', 'Choose a plan')
        return changePlan(ctx, { ...input, planPriceId: data.planPriceId })
      }
      if (data.action === 'cancel') await cancelSubscription(ctx, input)
      else await resumeSubscription(ctx, input)
      return { status: 'updated' }
    }),
  )
export const confirmCustomerCheckout = createServerFn({ method: 'POST' })
  .middleware([withWorkspace, withRealSession])
  .inputValidator(workspace.extend({ provider, providerRef: z.string().min(1).max(255) }))
  .handler(({ context, data }) =>
    safe(context.workspaceReadOnly, async () => {
      await confirmCheckout(service(context.db), {
        provider: data.provider,
        providerRef: data.providerRef,
        workspaceId: context.workspace.id,
        userId: context.user.id,
      })
      return { status: 'awaiting_payment' }
    }),
  )
