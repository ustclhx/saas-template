import { createDb, plan, planPrice } from '@saas/db'
import { readLocalEnv } from '@saas/db/worktree-env'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { seedCatalog, syncCatalog } from './catalog.ts'
import type { PaymentProvider, PlanSyncInput } from './provider.ts'

const url = readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
const migrationUrl = readLocalEnv('MIGRATION_DATABASE_URL')
if (!url || !migrationUrl)
  throw new Error('Catalog tests require both isolated worktree database URLs')
const app = new URL(url)
const migration = new URL(migrationUrl)
if (
  app.host !== migration.host ||
  app.pathname !== migration.pathname ||
  !(/^\/saas_wt_[a-z0-9_]+$/.test(app.pathname) || (process.env.CI && app.pathname === '/saas_ci'))
)
  throw new Error('Catalog tests require matching isolated saas_wt_* databases')
const db = createDb({ connectionString: url })
afterAll(() => db.$client.end())
function provider(id: 'stripe' | 'paypal') {
  return {
    id,
    syncPlan: vi.fn(async (input: PlanSyncInput) => ({
      providerPriceId: input.providerPriceId ?? `mock:${id}:${input.price.id}`,
    })),
  } as unknown as PaymentProvider
}

describe('catalog on isolated PostgreSQL', () => {
  it('serializes concurrent seeds, preserves historical prices, and retries partial sync', async () => {
    await Promise.all([seedCatalog(db), seedCatalog(db)])
    // Roll back mock mappings and historical fixture, retaining the seeded catalog.
    const rollback = new Error('rollback catalog fixture')
    await expect(
      db.transaction(async (tx) => {
        const fixture = tx as unknown as typeof db
        await seedCatalog(fixture)
        const plans = await tx
          .select()
          .from(plan)
          .where(inArray(plan.key, ['free', 'pro', 'team', 'credit_pack']))
        const catalogIds = plans.map((p) => p.id)
        expect(plans.find((p) => p.key === 'free')?.features).toEqual(DEFAULT_FREE_FEATURES)
        expect(
          plans.filter((p) => ['free', 'pro', 'team', 'credit_pack'].includes(p.key)),
        ).toHaveLength(4)
        let prices = await tx
          .select()
          .from(planPrice)
          .where(inArray(planPrice.planId, catalogIds))
          .orderBy(planPrice.id)
        expect(prices).toHaveLength(10)
        const first = prices[0]
        if (!first) throw new Error('Missing seeded price')
        const [historical] = await tx
          .insert(planPrice)
          .values({
            ...first,
            id: crypto.randomUUID(),
            amount: 123,
            providerPriceId: `historical:${crypto.randomUUID()}`,
          })
          .returning()
        const stripe = provider('stripe')
        const paypal = provider('paypal')
        vi.mocked(stripe.syncPlan)
          .mockImplementationOnce(async (i) => ({ providerPriceId: `mock:stripe:${i.price.id}` }))
          .mockRejectedValueOnce(new Error('partial failure'))
        await expect(syncCatalog(fixture, [stripe, paypal])).rejects.toThrow('partial failure')
        prices = await tx
          .select()
          .from(planPrice)
          .where(inArray(planPrice.planId, catalogIds))
          .orderBy(planPrice.id)
        expect(prices.filter((p) => p.active && p.id !== historical?.id)).toHaveLength(1)
        expect(
          prices
            .filter((p) => !p.active && p.id !== historical?.id)
            .every((p) => p.providerPriceId.startsWith('unsynced:')),
        ).toBe(true)
        await syncCatalog(fixture, [stripe, paypal])
        const before = await tx
          .select()
          .from(planPrice)
          .where(inArray(planPrice.planId, catalogIds))
          .orderBy(planPrice.id)
        await seedCatalog(fixture)
        await syncCatalog(fixture, [stripe, paypal])
        expect(
          await tx
            .select()
            .from(planPrice)
            .where(inArray(planPrice.planId, catalogIds))
            .orderBy(planPrice.id),
        ).toEqual(before)
        expect(
          await tx
            .select()
            .from(planPrice)
            .where(eq(planPrice.id, historical?.id ?? '')),
        ).toEqual([historical])
        throw rollback
      }),
    ).rejects.toBe(rollback)
  })
})
