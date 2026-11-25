import { AppError } from '@saas/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from './client.ts'
import { setting } from './schema/platform.ts'
import { defineSetting, type SettingDefinition } from './setting-definition.ts'
import projectSettings from './settings.project.ts'

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  )

// 仅允许 Discord 的 HTTPS Webhook，运行时设置不能成为任意出站请求的入口。
const normalizedDiscordUrl = z.url({ normalize: true })
const discordWebhookUrl = z.url().refine((value) => {
  const parsed = normalizedDiscordUrl.safeParse(value)
  return (
    parsed.success &&
    /^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+\??#?$/.test(parsed.data)
  )
})

export const templateSettings = {
  'auth.signupEnabled': defineSetting({
    schema: z.boolean(),
    default: true,
    description: '是否开放注册',
  }),
  'credits.dailyAmount': defineSetting({
    schema: z.number().int().min(1).max(2147483647),
    default: 10,
    description: '每日可领取的赠送积分',
  }),
  'credits.dailyMaxDaysPerMonth': defineSetting({
    schema: z.number().int().min(1).max(31),
    default: 10,
    description: '每月最多可领每日赠送积分的天数',
  }),
  'credits.dailyExpiryDays': defineSetting({
    schema: z.number().int().min(1).max(365),
    default: 7,
    description: '每日赠送积分的有效天数',
  }),
  'credits.dailyRequireVerifiedEmail': defineSetting({
    schema: z.boolean(),
    default: true,
    description: '领取每日赠送积分是否要求验证邮箱',
  }),
  'ai.mediaUncertainWaitSeconds': defineSetting({
    schema: z.number(),
    default: 3600,
    description: '媒体提交结果不确定时等待已验签回调的秒数，仍受任务期限约束',
  }),
  'site.announcement': defineSetting({
    schema: z.string().trim().max(2000),
    default: '',
    description: '站点公告，空字符串表示隐藏',
  }),
  'billing.signupBonusDomainBlacklist': defineSetting({
    schema: z
      .array(domain)
      .max(1000)
      .transform((domains) => [...new Set(domains)]),
    default: [],
    description: '不发放注册赠送积分的邮箱域名列表，每项填写域名',
  }),
  'operations.telegramBotToken': defineSetting({
    schema: z.string().regex(/^(?:\d+:[A-Za-z0-9_-]{20,200})?$/),
    default: '',
    description: '运营通知使用的 Telegram Bot 令牌，空字符串表示清除',
    secret: true,
  }),
  'operations.telegramChatId': defineSetting({
    schema: z
      .string()
      .trim()
      .max(100)
      .regex(/^(?:-?\d+|@[A-Za-z0-9_]+)?$/),
    default: '',
    description: '接收运营通知的 Telegram 对话 ID',
  }),
  'operations.discordWebhookUrl': defineSetting({
    schema: z.union([z.literal(''), discordWebhookUrl]),
    default: '',
    description:
      '运营通知使用的 HTTPS Webhook URL，支持 discord.com 和 discordapp.com，空字符串表示清除',
    secret: true,
  }),
  'ai.freeFailures': defineSetting({
    schema: z.object({
      count: z.number().int().min(0).max(1000),
      windowSeconds: z
        .number()
        .int()
        .min(60)
        .max(7 * 24 * 3600),
    }),
    default: { count: 3, windowSeconds: 3600 },
    description: '同一工作区在滚动窗口内无可见正文失败的免费次数',
  }),
}

type StaticDefinitions = typeof templateSettings & typeof projectSettings
export type SettingValues = {
  [K in keyof StaticDefinitions]: z.output<StaticDefinitions[K]['schema']>
}

export type SettingKey = keyof SettingValues
export type DailyCreditSettingKey = Extract<keyof typeof templateSettings, `credits.daily${string}`>

type NamedSettingDefinition = SettingDefinition & {
  readonly key: string
  readonly jsonSchema: z.core.JSONSchema.BaseSchema
}
const definitions = new Map<string, NamedSettingDefinition>()

/** 启动时合并扩展定义。整批验证后登记，避免冲突时只注册部分设置。 */
export function registerSettingDefinitions(group: Readonly<Record<string, SettingDefinition>>) {
  const entries = Object.entries(group)
  for (const [key, definition] of entries) {
    if (definitions.has(key)) throw new Error(`Duplicate runtime setting: ${key}`)
    if (!definition.schema.safeParse(definition.default).success) {
      throw new Error(`Invalid default for runtime setting: ${key}`)
    }
  }
  for (const [key, definition] of entries) {
    definitions.set(key, {
      ...definition,
      key,
      get jsonSchema() {
        return z.toJSONSchema(definition.schema, { io: 'input' })
      },
    })
  }
}

registerSettingDefinitions(templateSettings)
registerSettingDefinitions(projectSettings)

export const settingDefaults = Object.fromEntries(
  listSettingDefinitions().map(({ key, default: value }) => [key, value]),
) as SettingValues

/** JSON Schema 描述输入形态，写入时仍须执行 Zod 校验。 */
export function listSettingDefinitions(): readonly NamedSettingDefinition[] {
  return [...definitions.values()]
}

export function getSettingDefinition(key: string): NamedSettingDefinition | undefined {
  return definitions.get(key)
}

/** 校验并返回可写入的值，错误消息只包含键名。 */
export function validateSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValues[K]
export function validateSettingValue(key: string, value: unknown): unknown
export function validateSettingValue(key: string, value: unknown): unknown {
  const definition = definitions.get(key)
  if (!definition) throw new AppError('UNKNOWN_SETTING', `Unknown runtime setting: ${key}`)
  const result = definition.schema.safeParse(value)
  if (!result.success)
    throw new AppError('INVALID_SETTING_VALUE', `Invalid runtime setting: ${key}`)
  return result.data
}

/** 数据库/KV 与后台输入共用边界，避免绕过表单后发放非法额度。 */
export function isValidDailyCreditSetting<K extends DailyCreditSettingKey>(
  key: K,
  value: unknown,
): value is SettingValues[K] {
  return templateSettings[key].schema.safeParse(value).success
}

/** 读取设置的来源：返回表中该项的值，不存在时返回 `undefined`。 */
export interface SettingStore {
  find(key: string): Promise<unknown>
}

/**
 * 设置缓存，生产中由 KV 实现（`KVNamespace` 结构兼容）。
 * 缓存内容是 JSON 包装：`{"v": 值}` 表示表中存在，`{}` 表示表中缺失，两种结果都缓存。
 */
export interface SettingCache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface SettingsContext {
  store: SettingStore
  cache?: SettingCache | undefined
}

/** KV 允许的最小 TTL 为 60 秒；后台修改设置后最多 60 秒生效。 */
export const SETTING_CACHE_TTL_SECONDS = 60

const cacheKey = (key: string) => `setting:${key}`

export function dbSettingStore(db: Database): SettingStore {
  return {
    async find(key) {
      const rows = await db
        // postgres.js 已解析 JSON，避免 ORM 将字符串标量再次解码成布尔或数字。
        .select({ value: sql<unknown>`${setting.value}` })
        .from(setting)
        .where(eq(setting.key, key))
        .limit(1)
      return rows[0]?.value
    },
  }
}

export async function getSetting<K extends SettingKey>(
  ctx: SettingsContext,
  key: K,
): Promise<SettingValues[K]> {
  return (await getSettingValue(ctx, key)) as SettingValues[K]
}

/** 供按字符串键读取的调用方使用，包括运行时注册的功能模型设置。 */
export async function getSettingValue(ctx: SettingsContext, key: string): Promise<unknown> {
  const definition = definitions.get(key)
  if (!definition) throw new RangeError(`Unknown runtime setting: ${key}`)
  const cached = await ctx.cache?.get(cacheKey(key))
  if (cached != null) {
    return resolve(definition, (JSON.parse(cached) as { v?: unknown }).v)
  }
  const value = await ctx.store.find(key)
  const resolved = resolve(definition, value)
  await ctx.cache?.put(cacheKey(key), JSON.stringify(value === undefined ? {} : { v: value }), {
    expirationTtl: SETTING_CACHE_TTL_SECONDS,
  })
  return resolved
}

function resolve(definition: NamedSettingDefinition, value: unknown): unknown {
  const result = definition.schema.safeParse(value === undefined ? definition.default : value)
  if (!result.success) throw new RangeError(`Invalid runtime setting: ${definition.key}`)
  return result.data
}
