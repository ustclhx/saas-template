// biome-ignore-all lint/plugin: 跨空间的系统投递标记与归因读取没有单一租户归属。
import type { PlausibleSite } from '@saas/config'
import {
  auditLog,
  type Database,
  member,
  payment,
  plan,
  planPrice,
  user,
  userAttribution,
} from '@saas/db'
import { AppError } from '@saas/shared'
import {
  type AnalyticsEvent,
  analyticsProps,
  plausibleEventName,
  type ServerAnalyticsEvent,
} from '@saas/shared/analytics'
import { log } from '@saas/shared/log'
import { and, asc, eq } from 'drizzle-orm'

export interface ServerAnalyticsTarget {
  site: PlausibleSite
  /** 事件 URL 的站点地址：必须是本环境的 APP_URL，不能指向他站 */
  appUrl: string
}

interface ResolvedEvent {
  name: AnalyticsEvent
  sourceId: string
  path: string
  props: ReturnType<typeof analyticsProps>
  revenue?: { currency: string; amount: string }
  workspaceId?: string
  clientIp?: string
  userAgent?: string
}

async function attributionOf(db: Database, userId: string) {
  const [row] = await db
    .select({
      source: userAttribution.source,
      landingPath: userAttribution.landingPath,
      device: userAttribution.device,
      locale: user.locale,
    })
    .from(user)
    .leftJoin(userAttribution, eq(userAttribution.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1)
  return row
}

async function resolve(db: Database, event: ServerAnalyticsEvent): Promise<ResolvedEvent | null> {
  if (event.event === 'sign_up') {
    const row = await attributionOf(db, event.userId)
    if (!row) return null
    return {
      name: 'sign_up',
      sourceId: event.userId,
      path: '/register',
      props: analyticsProps({
        source: row.source ?? undefined,
        landing_path: row.landingPath ?? undefined,
        locale: row.locale ?? undefined,
        device: row.device ?? undefined,
      }),
      ...(event.clientIp ? { clientIp: event.clientIp } : {}),
      ...(event.userAgent ? { userAgent: event.userAgent } : {}),
    }
  }
  const [paid] = await db
    .select({
      workspaceId: payment.workspaceId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      plan: plan.key,
    })
    .from(payment)
    .leftJoin(planPrice, eq(planPrice.id, payment.planPriceId))
    .leftJoin(plan, eq(plan.id, planPrice.planId))
    .where(
      and(
        eq(payment.provider, event.provider as typeof payment.$inferSelect.provider),
        eq(payment.providerPaymentId, event.providerPaymentId),
      ),
    )
    .limit(1)
  // 事务已提交后才入队；查不到或已退款都不算一次成功付款。
  if (paid?.status !== 'succeeded') return null
  // 空间付款归因到所有者：个人空间即付款人本人，团队空间由所有者代表。
  const [owner] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, paid.workspaceId), eq(member.role, 'owner')))
    .orderBy(asc(member.createdAt))
    .limit(1)
  const row = owner ? await attributionOf(db, owner.userId) : undefined
  return {
    name: 'payment_success',
    sourceId: `${event.provider}:${event.providerPaymentId}`,
    path: '/app/billing',
    workspaceId: paid.workspaceId,
    props: analyticsProps({
      source: row?.source ?? undefined,
      landing_path: row?.landingPath ?? undefined,
      locale: row?.locale ?? undefined,
      plan: paid.plan ?? undefined,
      device: row?.device ?? undefined,
    }),
    revenue: { currency: paid.currency, amount: (paid.amount / 100).toFixed(2) },
  }
}

/** 发送失败抛出由队列重试；响应头标记被丢弃时只告警，重试同样会被丢弃。 */
async function send(target: ServerAnalyticsTarget, event: ResolvedEvent, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target.site.eventUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // Plausible 丢弃无 UA 或爬虫 UA 的事件；Webhook 没有用户 UA，用固定的非爬虫标识。
        'user-agent': event.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) SaasServerEvents/1.0',
        ...(event.clientIp ? { 'x-forwarded-for': event.clientIp } : {}),
      },
      body: JSON.stringify({
        name: plausibleEventName(event.name),
        domain: target.site.domain,
        url: new URL(event.path, target.appUrl).href,
        props: event.props,
        ...(event.revenue ? { revenue: event.revenue } : {}),
      }),
    })
    if (!response.ok) throw new Error('HTTP failure')
    if (response.headers.get('x-plausible-dropped'))
      log.warn('analytics.event_dropped', { event: event.name })
  } catch {
    // 不透传异常文本，只暴露事件名。
    throw new AppError('ANALYTICS_DELIVERY_FAILED', 'Analytics delivery failed', { status: 503 })
  } finally {
    clearTimeout(timer)
  }
}

/** 同一笔付款可能经多个 Webhook 事件到达；发送成功后写标记，重试与重复事件不会重复计数。 */
export async function deliverServerAnalytics(
  db: Database,
  target: ServerAnalyticsTarget | null | undefined,
  event: ServerAnalyticsEvent,
  timeoutMs = 5000,
) {
  if (!target) return
  const resolved = await resolve(db, event)
  if (!resolved) return
  const action = `analytics.sent.${resolved.name}`
  const [sent] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, resolved.sourceId)))
    .limit(1)
  if (sent) return
  await send(target, resolved, timeoutMs)
  await db.insert(auditLog).values({
    action,
    targetType: 'analytics_event',
    targetId: resolved.sourceId,
    ...(resolved.workspaceId ? { workspaceId: resolved.workspaceId } : {}),
  })
  log.info('analytics.delivered', { event: resolved.name })
}
