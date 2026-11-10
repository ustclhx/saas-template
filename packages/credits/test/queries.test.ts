import {
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  member,
  organization,
  payment,
  plan,
  planPrice,
  subscription,
  user,
} from '@saas/db'
import * as schema from '@saas/db/schema'
import { newId } from '@saas/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capture, grant, hold } from '../src/index.ts'

const url = process.env.CREDITS_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated test database')
const client = postgres(url, { max: 5 })
const db = drizzle(client, { schema })
let ws: string
let otherWs: string
let userId: string
const grantInput = (amount = 10, sourceRef = newId()) => ({
  workspaceId: ws,
  source: 'admin' as const,
  sourceRef,
  amount,
})

const holdInput = (amount = 8) => ({
  workspaceId: ws,
  userId,
  amount,
  refType: 'ai_message' as const,
  refId: newId(),
})

beforeEach(async () => {
  ws = newId()
  otherWs = newId()
  userId = newId()
  await db.insert(user).values({ id: userId, name: 'Credits', email: `${userId}@example.test` })
  await db.insert(organization).values([
    { id: ws, name: 'Credits', slug: ws },
    { id: otherWs, name: 'Other', slug: otherWs },
  ])
  await db.insert(member).values({ id: newId(), organizationId: ws, userId, role: 'owner' })
})

afterEach(async () => {
  const workspaces = [ws, otherWs]
  const holds = await db
    .select({ id: creditHold.id })
    .from(creditHold)
    .where(inArray(creditHold.workspaceId, workspaces))
  if (holds.length)
    await db.delete(creditHoldAllocation).where(
      inArray(
        creditHoldAllocation.holdId,
        holds.map((h) => h.id),
      ),
    )
  await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, workspaces))
  await db.delete(creditHold).where(inArray(creditHold.workspaceId, workspaces))
  await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, workspaces))
  await db.delete(creditDebt).where(inArray(creditDebt.workspaceId, workspaces))
  await db.delete(payment).where(inArray(payment.workspaceId, workspaces))
  await db.delete(subscription).where(inArray(subscription.workspaceId, workspaces))
  await db.delete(planPrice).where(eq(planPrice.planId, ws))
  await db.delete(plan).where(eq(plan.id, ws))
  await db.delete(member).where(inArray(member.organizationId, workspaces))
  await db.delete(organization).where(inArray(organization.id, workspaces))
  await db.delete(user).where(eq(user.id, userId))
})

afterAll(() => client.end())

import { expireWorkspaceCredits } from '../src/lifecycle.ts'
import {
  getCreditBalance,
  getCreditBatches,
  getCreditLedger,
  getCreditSummary,
  reconcileWorkspaceCredits,
} from '../src/queries.ts'

describe('credit queries on PostgreSQL', () => {
  it('separates spendable balance from pending-expiry accounting and detects mismatches', async () => {
    const expired = await grant(db, grantInput(10))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, expired.id))
    await grant(db, grantInput(20))
    const reservation = await hold(db, holdInput(8))
    await capture(db, {
      workspaceId: ws,
      holdId: reservation.id,
      actualAmount: 50,
      overage: { maxCredits: 0 },
    })
    await grant(db, { ...grantInput(99), workspaceId: otherWs })
    expect(await getCreditBalance(db, ws)).toEqual({ available: 0, held: 0, debt: 30 })
    expect(await reconcileWorkspaceCredits(db, ws)).toMatchObject({
      activeRemaining: 0,
      consistent: true,
      debt: 30,
    })
    const pending = await grant(db, grantInput(40))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, pending.id))
    expect(await getCreditBalance(db, ws)).toEqual({ available: 0, held: 0, debt: 0 })
    expect(await reconcileWorkspaceCredits(db, ws)).toMatchObject({
      activeRemaining: 10,
      ledgerTotal: 10,
      consistent: true,
    })
    await expireWorkspaceCredits(db, ws)
    expect(await reconcileWorkspaceCredits(db, ws)).toMatchObject({
      activeRemaining: 0,
      consistent: true,
    })
    await db.insert(creditLedger).values({ workspaceId: ws, type: 'adjust', delta: 1 })
    expect(await reconcileWorkspaceCredits(db, ws)).toMatchObject({
      consistent: false,
      difference: 1,
    })
    expect(await getCreditBalance(db, otherWs)).toEqual({ available: 99, held: 0, debt: 0 })
    expect(await getCreditBalance(db, newId())).toEqual({ available: 0, held: 0, debt: 0 })
  })

  it('summarizes spendable sources with held/expired/revoked exclusion and annual month-end rollover', async () => {
    await grant(db, { ...grantInput(20), source: 'purchase' })
    await hold(db, holdInput(8))
    await grant(db, { ...grantInput(5), source: 'signup' })
    // daily remains text-compatible until R3 extends the TypeScript source union.
    await db.insert(creditGrant).values({ ...grantInput(3), source: sql`'daily'`, remaining: 3 })
    await grant(db, grantInput(7))
    const expired = await grant(db, grantInput(99))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, expired.id))
    const revoked = await grant(db, grantInput(99))
    await db.update(creditGrant).set({ status: 'revoked' }).where(eq(creditGrant.id, revoked.id))
    await grant(db, { ...grantInput(999), workspaceId: otherWs })
    await db.insert(plan).values({
      id: ws,
      key: ws,
      name: 'Annual',
      type: 'subscription',
      credits: 30,
      rollover: true,
      features: {
        models: [],
        maxConcurrentTasks: 3,
        maxSeats: 1,
        storageGb: 5,
        publicApi: false,
        priorityQueue: false,
        watermark: true,
      },
    })
    const priceId = newId()
    const subId = newId()
    const paymentId = newId()
    const periodStart = new Date('2026-01-31T12:30:00Z')
    const periodEnd = new Date('2027-01-31T12:30:00Z')
    await db.insert(planPrice).values({
      id: priceId,
      planId: ws,
      provider: 'stripe',
      providerPriceId: newId(),
      interval: 'year',
      amount: 1000,
      currency: 'usd',
    })
    await db.insert(subscription).values({
      id: subId,
      workspaceId: ws,
      planId: ws,
      planPriceId: priceId,
      provider: 'stripe',
      providerSubscriptionId: newId(),
      status: 'active',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      lastEventAt: periodStart,
    })
    await db.insert(payment).values({
      id: paymentId,
      workspaceId: ws,
      provider: 'stripe',
      providerPaymentId: newId(),
      subscriptionId: subId,
      planPriceId: priceId,
      kind: 'initial',
      periodStart,
      periodEnd,
      amount: 1000,
      currency: 'usd',
      paidAt: periodStart,
    })
    for (const [n, amount] of [
      [1, 10],
      [2, 30],
    ] as const) {
      await grant(db, {
        ...grantInput(amount),
        source: 'subscription',
        sourceRef: `${paymentId}:${n}`,
        paymentId,
      })
    }
    // Arrival time does not define the paid monthly grant window.
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(0) })
      .where(eq(creditGrant.paymentId, paymentId))
    const before = await getCreditSummary(db, ws, new Date('2026-03-31T12:29:59Z'))
    expect(before.subscriptionCurrentMonth).toBe(10)
    const summary = await getCreditSummary(db, ws, new Date('2026-03-31T12:30:00Z'))
    expect(summary).toEqual({
      subscriptionAvailable: 40,
      subscriptionCurrentMonth: 30,
      creditPack: 12,
      free: { signup: 5, daily: 3, total: 8 },
      other: 7,
      available: 67,
    })
    expect(
      summary.subscriptionAvailable + summary.creditPack + summary.free.total + summary.other,
    ).toBe(summary.available)
    expect((await getCreditSummary(db, otherWs)).available).toBe(999)
    expect((await getCreditSummary(db, newId())).available).toBe(0)
  })

  it('paginates tied timestamps newest first by ID without losing microseconds or leaking workspaces', async () => {
    for (let n = 0; n < 5; n++) await grant(db, grantInput(n + 1))
    await grant(db, { ...grantInput(99), workspaceId: otherWs })
    await db
      .update(creditLedger)
      .set({ createdAt: sql`'2026-01-01T00:00:00.123456Z'::timestamptz` })
      .where(eq(creditLedger.workspaceId, ws))
    await db
      .update(creditGrant)
      .set({ createdAt: sql`'2026-01-01T00:00:00.123456Z'::timestamptz` })
      .where(eq(creditGrant.workspaceId, ws))
    for (const query of [getCreditLedger, getCreditBatches]) {
      const first = await query(db, ws, { limit: 2 })
      expect(first.nextCursor?.createdAt).toBe('2026-01-01T00:00:00.123456Z')
      const second = await query(db, ws, {
        limit: 2,
        ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      })
      const third = await query(db, ws, {
        limit: 2,
        ...(second.nextCursor ? { cursor: second.nextCursor } : {}),
      })
      const items = [...first.items, ...second.items, ...third.items]
      expect(items).toHaveLength(5)
      expect(new Set(items.map((i) => i.id)).size).toBe(5)
      expect(items.map((i) => i.id)).toEqual(
        items
          .map((i) => i.id)
          .sort()
          .reverse(),
      )
      expect(items.every((i) => i.workspaceId === ws)).toBe(true)
      expect(third.nextCursor).toBeNull()
    }
  })

  it('member filter returns only own consumption across every page', async () => {
    await grant(db, grantInput(20))
    for (let n = 0; n < 3; n++) {
      const reservation = await hold(db, holdInput(2))
      await capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 2 })
    }
    const other = newId()
    await db.insert(user).values({ id: other, name: 'Other', email: `${other}@example.test` })
    try {
      await db.insert(creditLedger).values({
        workspaceId: ws,
        userId: other,
        type: 'consume',
        delta: 0,
        refId: 'private-other-ref',
      })
      const first = await getCreditLedger(db, ws, { limit: 2, userId })
      const second = await getCreditLedger(db, ws, {
        limit: 2,
        userId,
        ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      })
      expect([...first.items, ...second.items]).toHaveLength(3)
      expect(
        [...first.items, ...second.items].every((i) => i.userId === userId && i.type === 'consume'),
      ).toBe(true)
      expect(second.nextCursor).toBeNull()
      expect((await getCreditLedger(db, otherWs, { userId })).items).toEqual([])
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.userId, other))
      await db.delete(user).where(eq(user.id, other))
    }
  })

  it('rejects unbounded limits and malformed external cursors before querying', async () => {
    for (const query of [getCreditLedger, getCreditBatches]) {
      for (const limit of [0, -1, 101, 1.5, Number.NaN])
        await expect(query(db, ws, { limit })).rejects.toThrow(RangeError)
      await expect(query(db, ws, { cursor: { createdAt: 'bad', id: newId() } })).rejects.toThrow(
        RangeError,
      )
      await expect(
        query(db, ws, { cursor: { createdAt: new Date().toISOString(), id: 'bad' } }),
      ).rejects.toThrow(RangeError)
    }
  })
})
