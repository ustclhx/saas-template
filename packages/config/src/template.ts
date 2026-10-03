/**
 * 模板配置（`template.config.ts`）：功能开关与产品形态，改代码、重新部署才生效。
 * 除 `app` 外每一项都有默认值（取自 docs/02-project-structure.md §3 草案），
 * 非法取值（未知的登录方式、计费方式等）在类型检查阶段报错。
 */

export type OAuthProvider = 'google' | 'github'
export type PaymentProvider = 'stripe' | 'paypal'
/** 'per_call' 按次 | 'token' 按 token | 'per_unit' 按张/秒 */
export type PricingMode = 'per_call' | 'token' | 'per_unit'
export type AiModality = 'text' | 'image' | 'video'

export type DefaultLocale = 'en' | 'zh'

/** 解析后的完整配置：所有选项都有值。 */
export interface TemplateConfig<L extends string = string> {
  readonly app: {
    readonly name: string
    readonly url: string
    readonly supportEmail: string
  }
  readonly i18n: {
    readonly locales: readonly L[]
    readonly defaultLocale: L
  }
  readonly tenancy: {
    /** false = 仅个人空间；true = 允许团队 workspace */
    readonly multiTenant: boolean
    readonly maxWorkspacesPerUser: number
  }
  readonly auth: {
    readonly emailPassword: boolean
    /** 邮箱验证码登录（emailOTP 插件） */
    readonly emailOtp: boolean
    /** 魔法链接登录（magicLink 插件） */
    readonly magicLink: boolean
    readonly oauth: readonly OAuthProvider[]
    readonly twoFactor: boolean
    readonly turnstile: boolean
  }
  readonly billing: {
    /** 结账页展示顺序 */
    readonly providers: readonly PaymentProvider[]
    /** ISO 4217 小写货币代码 */
    readonly currency: Lowercase<string>
    /** 邮箱验证后发放 */
    readonly signupBonusCredits: number
    /** past_due 期间保留权益的天数 */
    readonly pastDueGraceDays: number
    /** 订阅积分批次在周期末之后的额外有效期 */
    readonly subscriptionCreditGraceHours: number
    /** 实际消耗超出预扣时平台承担的上限，超出部分从余额补扣 / 记欠费 */
    readonly overage: {
      /** 单次最多承担预扣额的比例 */
      readonly maxRatio: number
      /** 单次最多承担的积分 */
      readonly maxCredits: number
      /** 每个空间每天最多承担的积分 */
      readonly dailyBudgetPerWorkspace: number
    }
    /** 可申请退款的付款时间范围；退款需人工审核，默认不主动退 */
    readonly refundWindowDays: number
  }
  readonly ai: {
    readonly text: boolean
    readonly image: boolean
    readonly video: boolean
    /** 新建模型时的默认计费方式，后台可逐个模型修改 */
    readonly defaultPricingMode: { readonly [M in AiModality]: PricingMode }
  }
  readonly features: {
    /** API Key 调用 /api/v1 */
    readonly publicApi: boolean
    readonly blog: boolean
    readonly docs: boolean
    readonly waitlist: boolean
  }
}

type Section<K extends keyof TemplateConfig> = TemplateConfig[K]

/** `defineTemplateConfig` 的输入：`app` 必填，其余各项均可省略，嵌套对象可只写部分字段。 */
export interface TemplateConfigInput<L extends string = DefaultLocale> {
  app: Section<'app'>
  i18n?: {
    locales?: readonly L[]
    /** 必须是 `locales` 之一；省略时取 `locales[0]` */
    defaultLocale?: NoInfer<L>
  }
  tenancy?: Partial<Section<'tenancy'>>
  auth?: Partial<Section<'auth'>>
  billing?: Partial<Omit<Section<'billing'>, 'overage'>> & {
    overage?: Partial<Section<'billing'>['overage']>
  }
  ai?: Partial<Omit<Section<'ai'>, 'defaultPricingMode'>> & {
    defaultPricingMode?: Partial<Section<'ai'>['defaultPricingMode']>
  }
  features?: Partial<Section<'features'>>
}

/** 除 `app` 外的默认值，与 docs/02-project-structure.md §3 草案一致。 */
export const templateConfigDefaults = {
  i18n: { locales: ['en', 'zh'], defaultLocale: 'en' },
  tenancy: { multiTenant: false, maxWorkspacesPerUser: 5 },
  auth: {
    emailPassword: true,
    emailOtp: true,
    magicLink: false,
    oauth: ['google', 'github'],
    twoFactor: false,
    turnstile: true,
  },
  billing: {
    providers: ['stripe', 'paypal'],
    currency: 'usd',
    signupBonusCredits: 100,
    pastDueGraceDays: 7,
    subscriptionCreditGraceHours: 24,
    overage: { maxRatio: 0.2, maxCredits: 50, dailyBudgetPerWorkspace: 200 },
    refundWindowDays: 30,
  },
  ai: {
    text: true,
    image: true,
    video: true,
    defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_call' },
  },
  features: { publicApi: false, blog: true, docs: false, waitlist: false },
} as const satisfies Omit<TemplateConfig<DefaultLocale>, 'app'>

/** 合并用户配置与默认值；数组整体替换，不与默认值合并。 */
export function defineTemplateConfig<const L extends string = DefaultLocale>(
  input: TemplateConfigInput<L>,
): TemplateConfig<L> {
  const d = templateConfigDefaults
  // 未提供 locales 时 L 取默认值 DefaultLocale，因此默认 locales 的类型与 L 一致
  const locales = input.i18n?.locales ?? (d.i18n.locales as readonly string[] as readonly L[])
  const defaultLocale = input.i18n?.defaultLocale ?? locales[0]
  if (defaultLocale === undefined) {
    throw new RangeError('template config: i18n.locales must not be empty')
  }
  if (!locales.includes(defaultLocale)) {
    throw new RangeError('template config: i18n.defaultLocale must be one of i18n.locales')
  }

  return {
    app: { ...input.app },
    i18n: { locales, defaultLocale },
    tenancy: { ...d.tenancy, ...input.tenancy },
    auth: { ...d.auth, ...input.auth },
    billing: {
      ...d.billing,
      ...input.billing,
      overage: { ...d.billing.overage, ...input.billing?.overage },
    },
    ai: {
      ...d.ai,
      ...input.ai,
      defaultPricingMode: { ...d.ai.defaultPricingMode, ...input.ai?.defaultPricingMode },
    },
    features: { ...d.features, ...input.features },
  }
}
