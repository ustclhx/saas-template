import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { type BillingCreditSummary, billingSections, CreditBalance } from './billing-sections.tsx'

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => overwriteGetLocale(() => baseLocale))

const plans = [
  { id: 'sub', type: 'subscription' as const },
  { id: 'pack', type: 'credit_pack' as const },
]
const summary: BillingCreditSummary = {
  subscription: { total: 800, currentPeriod: 800 },
  purchase: 400,
  free: { signup: 50, daily: 10, total: 60 },
  other: 0,
  available: 1260,
}

describe('账单页分区（add-ui-design-system 8.7）', () => {
  it('分区按数据来源渲染：无价格的套餐类型且无持有记录时不渲染', () => {
    expect(
      billingSections({
        plans,
        prices: [{ planId: 'sub' }, { planId: 'pack' }],
        subscriptionCount: 0,
        summary,
        freeConfigured: true,
      }),
    ).toEqual({ subscription: true, packs: true, free: true })
    expect(
      billingSections({
        plans,
        prices: [{ planId: 'pack' }],
        subscriptionCount: 0,
        summary: { ...summary, free: { signup: 0, daily: 0, total: 0 } },
        freeConfigured: false,
      }),
    ).toEqual({ subscription: false, packs: true, free: false })
    // 已有订阅或已持有积分包 / 免费积分时，即使目录下架也保留对应分区
    expect(
      billingSections({
        plans: [],
        prices: [],
        subscriptionCount: 1,
        summary,
        freeConfigured: false,
      }),
    ).toEqual({ subscription: true, packs: true, free: true })
  })

  it('余额只渲染有来源的分区卡片，免费积分拆分注册赠送与每日领取', () => {
    const render = (sections: Parameters<typeof billingSections>[0]) =>
      renderToStaticMarkup(
        <CreditBalance
          summary={summary}
          sections={billingSections(sections)}
          planCredits={1000}
          renewalAt="2026-12-10T00:00:00Z"
          packExpiry={null}
          daily={{ status: 'already_claimed' }}
        />,
      )
    const all = render({
      plans,
      prices: [{ planId: 'sub' }, { planId: 'pack' }],
      subscriptionCount: 0,
      summary,
      freeConfigured: true,
    })
    expect(all).toContain(m.billing_page_sub_credits())
    expect(all).toContain('aria-valuenow="80"')
    expect(all).toContain(m.billing_page_pack_credits())
    expect(all).toContain(m.billing_page_free_credits())
    expect(all).toContain(m.billing_page_signup())
    expect(all).toContain(m.billing_page_daily_claimed())
    const packsOnly = render({
      plans: [{ id: 'pack', type: 'credit_pack' }],
      prices: [{ planId: 'pack' }],
      subscriptionCount: 0,
      summary: { ...summary, free: { signup: 0, daily: 0, total: 0 } },
      freeConfigured: false,
    })
    expect(packsOnly).toContain(m.billing_page_pack_credits())
    expect(packsOnly).not.toContain(m.billing_page_sub_credits())
    expect(packsOnly).not.toContain(m.billing_page_free_credits())
  })
})
