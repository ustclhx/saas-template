import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  defineTemplateConfig,
  type PaymentProvider,
  type PricingMode,
  type TemplateConfig,
  templateConfigDefaults,
} from './template.ts'

const app = { name: 'MyApp', url: 'https://example.com', supportEmail: 'support@example.com' }

describe('defineTemplateConfig', () => {
  it('fills every omitted option with the documented default', () => {
    const config = defineTemplateConfig({ app })
    expect(config).toEqual({ app, ...templateConfigDefaults })
    expect(config.billing.overage).toEqual({
      maxRatio: 0.2,
      maxCredits: 50,
      dailyBudgetPerWorkspace: 200,
    })
  })

  it('merges nested sections field by field', () => {
    const config = defineTemplateConfig({
      app,
      billing: { overage: { maxCredits: 10 } },
      ai: { video: false, defaultPricingMode: { video: 'per_unit' } },
    })
    expect(config.billing.overage).toEqual({
      maxRatio: 0.2,
      maxCredits: 10,
      dailyBudgetPerWorkspace: 200,
    })
    expect(config.billing.refundWindowDays).toBe(30)
    expect(config.ai).toEqual({
      text: true,
      image: true,
      video: false,
      defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_unit' },
    })
  })

  it('replaces arrays instead of merging them', () => {
    const config = defineTemplateConfig({ app, auth: { oauth: ['github'] } })
    expect(config.auth.oauth).toEqual(['github'])
    expect(config.auth.emailPassword).toBe(true)
  })

  it('defaults defaultLocale to the first locale', () => {
    const config = defineTemplateConfig({ app, i18n: { locales: ['ja', 'en'] } })
    expect(config.i18n).toEqual({ locales: ['ja', 'en'], defaultLocale: 'ja' })
    expectTypeOf(config.i18n.defaultLocale).toEqualTypeOf<'ja' | 'en'>()
  })

  it('rejects an empty locale list at runtime', () => {
    expect(() => defineTemplateConfig({ app, i18n: { locales: [] } })).toThrow(RangeError)
  })

  it('does not share nested objects with the defaults', () => {
    const config = defineTemplateConfig({ app })
    expect(config.billing.overage).not.toBe(templateConfigDefaults.billing.overage)
  })
})

describe('defineTemplateConfig types', () => {
  it('resolves every option to a non-optional value', () => {
    const config = defineTemplateConfig({ app })
    expectTypeOf(config).toEqualTypeOf<TemplateConfig<'en' | 'zh'>>()
    expectTypeOf(config.billing.overage.maxRatio).toEqualTypeOf<number>()
    expectTypeOf(config.ai.defaultPricingMode.video).toEqualTypeOf<PricingMode>()
    expectTypeOf(config.billing.providers).toEqualTypeOf<readonly PaymentProvider[]>()
  })

  it('rejects invalid values at type-check time', () => {
    // 每个 @ts-expect-error 都要求下一行确实有类型错误，否则 typecheck 失败
    const invalid = () => [
      // @ts-expect-error 未定义的计费方式
      defineTemplateConfig({ app, ai: { defaultPricingMode: { video: 'per_minute' } } }),
      // @ts-expect-error 未知的 OAuth 登录方式
      defineTemplateConfig({ app, auth: { oauth: ['google', 'facebook'] } }),
      // @ts-expect-error 未知的支付方式
      defineTemplateConfig({ app, billing: { providers: ['alipay'] } }),
      // @ts-expect-error 未知的配置项
      defineTemplateConfig({ app, billing: { overage: { maxPercent: 10 } } }),
      // @ts-expect-error 类型错误的取值
      defineTemplateConfig({ app, tenancy: { multiTenant: 'yes' } }),
      // @ts-expect-error defaultLocale 不在 locales 中
      defineTemplateConfig({ app, i18n: { locales: ['en', 'zh'], defaultLocale: 'fr' } }),
      // @ts-expect-error 省略 locales 时 defaultLocale 只能是默认语言之一
      defineTemplateConfig({ app, i18n: { defaultLocale: 'fr' } }),
      // @ts-expect-error app 必填
      defineTemplateConfig({}),
    ]
    expectTypeOf(invalid).toBeFunction()
  })
})
