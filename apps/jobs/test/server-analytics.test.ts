import { env } from 'cloudflare:workers'
import {
  auditLog,
  createDb,
  member,
  organization,
  payment,
  plan,
  planPrice,
  purchase,
  user,
  userAttribution,
} from '@saas/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { deliverServerAnalytics } from '../src/notifications/analytics.ts'

// 消费者的查询必须对得上真实表结构：付款 → 套餐、空间 → 所有者 → 首触归因。
const db = createDb(env.HYPERDRIVE)
const id = () => crypto.randomUUID()
const target = {
  appUrl: 'https://own.example',
  site: {
    domain: 'own-staging',
    origin: 'https://plausible.example',
    scriptUrl: 'https://plausible.example/js/script.manual.js',
    eventUrl: 'https://plausible.example/api/event',
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => db.$client.end())

async function paidWorkspace() {
  const ws = id()
  const key = `analytics-${ws}`
  await db
    .insert(user)
    .values({ id: ws, name: 'Payer', email: `${ws}@analytics.example.test`, locale: 'zh' })
  await db.insert(organization).values({ id: ws, name: 'Payer', slug: ws })
  await db.insert(member).values({ id: id(), userId: ws, organizationId: ws, role: 'owner' })
  await db.insert(userAttribution).values({
    userId: ws,
    source: 'chatgpt',
    landingPath: '/guides/x',
    device: 'mobile',
    firstSeenAt: new Date(),
  })
  const planId = id()
  const priceId = id()
  await db.insert(plan).values({
    id: planId,
    key,
    name: 'Pro',
    type: 'credit_pack',
    credits: 10,
    features: {} as never,
  })
  await db.insert(planPrice).values({
    id: priceId,
    planId,
    provider: 'stripe',
    providerPriceId: key,
    amount: 1999,
    currency: 'USD',
  })
  const purchaseId = id()
  await db.insert(purchase).values({
    id: purchaseId,
    workspaceId: ws,
    userId: ws,
    planId,
    planPriceId: priceId,
    provider: 'stripe',
    providerOrderId: key,
    amount: 1999,
    currency: 'USD',
    status: 'paid',
  })
  await db.insert(payment).values({
    workspaceId: ws,
    purchaseId,
    provider: 'stripe',
    providerPaymentId: key,
    planPriceId: priceId,
    kind: 'one_time',
    amount: 1999,
    currency: 'USD',
    paidAt: new Date(),
    status: 'succeeded',
  })
  return { ws, key }
}

it('付款事件读取真实归因与套餐，重复投递只发送一次，账号归因随用户级联', async () => {
  const fetchMock = vi.fn(async () => new Response('ok', { status: 202 }))
  vi.stubGlobal('fetch', fetchMock)
  const { ws, key } = await paidWorkspace()
  const event = { event: 'payment_success', provider: 'stripe', providerPaymentId: key } as const
  await deliverServerAnalytics(db, target, event)
  await deliverServerAnalytics(db, target, event)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
  expect(JSON.parse(String(init.body))).toMatchObject({
    name: 'payment_success',
    domain: 'own-staging',
    props: {
      source: 'chatgpt',
      landing_path: '/guides/x',
      locale: 'zh',
      plan: key,
      device: 'mobile',
    },
    revenue: { currency: 'USD', amount: '19.99' },
  })
  const marks = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.targetId, `stripe:${key}`))
  expect(marks).toEqual([{ action: 'analytics.sent.payment_success' }])
  expect(
    await db.select().from(userAttribution).where(eq(userAttribution.userId, ws)),
  ).toHaveLength(1)
})
