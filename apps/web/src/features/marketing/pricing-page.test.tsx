import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { examplePricingCatalog } from '../../../scripts/pricing-snapshot.ts'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { marketingPlans, packExpiryDays, planPrice, yearlySavingPercent } from './pricing-data.ts'
import { PricingGroups } from './pricing-page.tsx'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => overwriteGetLocale(() => baseLocale))

const plans = marketingPlans(examplePricingCatalog())
const subscriptions = plans.filter((plan) => plan.type === 'subscription')
const packs = plans.filter((plan) => plan.type === 'credit_pack')
const render = (input: typeof plans, interval: 'month' | 'year' = 'month') =>
  renderToStaticMarkup(<PricingGroups plans={input} paymentsAvailable initialInterval={interval} />)

describe('定价页订阅与积分包并列（add-ui-design-system 8.7）', () => {
  it('两组并存时同时显示订阅、积分包与只作用于订阅的周期切换', () => {
    const html = render(plans)
    expect(html).toContain(m.pricing_page_subscriptions())
    expect(html).toContain(m.pricing_page_packs())
    expect(html).toContain(`<legend class="sr-only">${m.pricing_page_cycle()}</legend>`)
    expect(html).toContain(m.pricing_page_pack_order())
  })

  it('切换年付只改变订阅价格，积分包价格不变', () => {
    const pro = subscriptions.find((plan) => plan.key === 'pro')
    const pack = packs[0]
    if (!pro || !pack) throw new Error('示例目录缺少订阅或积分包')
    expect(planPrice(pro, 'month')?.amount).toBe(1900)
    expect(planPrice(pro, 'year')?.amount).toBe(19000)
    expect(planPrice(pack, 'month')).toEqual(planPrice(pack, 'year'))
    const monthly = render(plans, 'month')
    const yearly = render(plans, 'year')
    expect(monthly).toContain('$19')
    expect(yearly).toContain('$190')
    expect(yearly).not.toContain('$19<')
    // 积分包价格两种周期下一致
    expect(monthly).toContain('$10')
    expect(yearly).toContain('$10')
  })

  it('只有积分包时不显示周期切换与订阅组', () => {
    const html = render(packs)
    expect(html).toContain(m.pricing_page_packs())
    expect(html).not.toContain(m.pricing_page_subscriptions())
    expect(html).not.toContain(m.pricing_page_cycle())
    expect(html).not.toContain(m.pricing_page_monthly())
    // 只有一种类型时不提示叠加扣费顺序
    expect(html).not.toContain(m.pricing_page_pack_order())
  })

  it('只有订阅时保持订阅组与周期切换，不显示积分包组', () => {
    const html = render(subscriptions)
    expect(html).toContain(m.pricing_page_cycle())
    expect(html).not.toContain(m.pricing_page_packs())
  })

  it('没有任何套餐时显示空状态；支付不可用时给出说明', () => {
    expect(render([])).toContain(m.pricing_page_empty_title())
    const html = renderToStaticMarkup(<PricingGroups plans={plans} paymentsAvailable={false} />)
    expect(html).toContain(m.pricing_page_payments_unavailable())
  })

  it('年付节省比例与积分包有效期来自套餐数据', () => {
    expect(yearlySavingPercent(subscriptions)).toBe(17)
    expect(packExpiryDays(packs)).toBe(365)
    expect(packExpiryDays([{ creditExpiryDays: null }])).toBeNull()
  })
})
