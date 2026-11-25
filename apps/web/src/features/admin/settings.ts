import { featureModels } from '@saas/ai'
import {
  aiModel,
  type Database,
  dbSettingStore,
  getSettingDefinition,
  resolveStoredSetting,
  type SettingKey,
  type SettingValues,
  setting,
  validateSettingValue,
} from '@saas/db'
import { AppError } from '@saas/shared'
import { eq, sql } from 'drizzle-orm'
import type { AdminActionScope } from './action.ts'
import type { RuntimeSettingsInput } from './settings-schema.ts'

export const RUNTIME_SETTING_KEYS = [
  'auth.signupEnabled',
  'site.announcement',
  'billing.signupBonusDomainBlacklist',
  'ai.freeFailures',
  'credits.dailyAmount',
  'credits.dailyMaxDaysPerMonth',
  'credits.dailyExpiryDays',
  'credits.dailyRequireVerifiedEmail',
] as const satisfies readonly SettingKey[]

export async function readRuntimeSettings(db: Database) {
  // 后台表单直接读事实来源，避免用旧缓存覆盖刚保存的设置。
  const store = dbSettingStore(db)
  const resolved = new Map(
    await Promise.all(
      RUNTIME_SETTING_KEYS.map(
        async (key) => [key, resolveStoredSetting(key, await store.find(key))] as const,
      ),
    ),
  )
  const value = <K extends (typeof RUNTIME_SETTING_KEYS)[number]>(key: K) =>
    resolved.get(key)?.value as SettingValues[K]
  return {
    signupEnabled: value('auth.signupEnabled'),
    announcement: value('site.announcement'),
    signupBonusDomainBlacklist: value('billing.signupBonusDomainBlacklist'),
    freeFailures: value('ai.freeFailures'),
    dailyAmount: value('credits.dailyAmount'),
    dailyMaxDaysPerMonth: value('credits.dailyMaxDaysPerMonth'),
    dailyExpiryDays: value('credits.dailyExpiryDays'),
    dailyRequireVerifiedEmail: value('credits.dailyRequireVerifiedEmail'),
    /** 已存值不符合当前定义、正在使用默认值的键；保存表单即以合法值覆盖 */
    fallbackKeys: RUNTIME_SETTING_KEYS.filter((key) => resolved.get(key)?.source === 'fallback'),
  }
}

function requireSettingDefinition(key: string) {
  const definition = getSettingDefinition(key)
  if (!definition) throw new AppError('UNKNOWN_SETTING', 'Unknown runtime setting')
  return definition
}

export async function readRuntimeSetting(db: Database, key: string) {
  const definition = requireSettingDefinition(key)
  const { value, source } = resolveStoredSetting(key, await dbSettingStore(db).find(key))
  return { definition, value, source }
}

/** 业务写入与前后值审计同事务；锁覆盖缺失行，首次保存也不会丢失并发修改的旧值。 */
export async function writeRuntimeSetting(
  { tx, audit }: AdminActionScope,
  key: string,
  input: unknown,
  dryRun = false,
) {
  const definition = requireSettingDefinition(key)
  const value = validateSettingValue(key, input)
  const feature = key.startsWith('ai.model.') ? key.slice('ai.model.'.length) : ''
  if (value && Object.hasOwn(featureModels, feature)) {
    const query = tx
      .select({ kind: aiModel.kind })
      .from(aiModel)
      .where(eq(aiModel.key, String(value)))
    const [model] = dryRun ? await query : await query.for('share')
    if (model?.kind !== featureModels[feature]?.kind) {
      throw new AppError('INVALID_SETTING_VALUE', 'Select an existing model of the feature kind')
    }
  }

  if (!dryRun)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`setting:${key}`}, 0))`)
  const query = tx
    // 与 dbSettingStore 一样，保留 JSON 字符串标量的原始类型。
    .select({ value: sql<unknown>`${setting.value}` })
    .from(setting)
    .where(eq(setting.key, key))
  const [before] = dryRun ? await query : await query.for('update')
  const oldValue = before === undefined ? definition.default : before.value
  const changes = definition.secret
    ? { oldValue: '[redacted]', newValue: '[redacted]' }
    : { oldValue, newValue: value }
  if (!dryRun) {
    await tx
      .insert(setting)
      .values({ key, value })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
    await audit({
      action: 'setting.updated',
      targetType: 'setting',
      targetId: key,
      meta: { key, ...changes, changes },
    })
  }
  return changes
}

/** 后台设置表单对应的设置项（键与新值），写入与 step-up 判定共用 */
export function runtimeSettingEntries(input: RuntimeSettingsInput) {
  const values: Pick<SettingValues, (typeof RUNTIME_SETTING_KEYS)[number]> = {
    'auth.signupEnabled': input.signupEnabled,
    'site.announcement': input.announcement,
    'billing.signupBonusDomainBlacklist': input.signupBonusDomainBlacklist,
    'ai.freeFailures': input.freeFailures,
    'credits.dailyAmount': input.dailyAmount,
    'credits.dailyMaxDaysPerMonth': input.dailyMaxDaysPerMonth,
    'credits.dailyExpiryDays': input.dailyExpiryDays,
    'credits.dailyRequireVerifiedEmail': input.dailyRequireVerifiedEmail,
  }
  return RUNTIME_SETTING_KEYS.map((key) => [key, values[key]] as const)
}

export async function writeRuntimeSettings(scope: AdminActionScope, input: RuntimeSettingsInput) {
  for (const [key, value] of runtimeSettingEntries(input))
    await writeRuntimeSetting(scope, key, value)
}

/** 只在事务提交后删除；失败时保留已提交值并向调用方报告，KV TTL 仍限制陈旧时间。 */
export async function invalidateRuntimeSettings(
  cache: { delete(key: string): Promise<void> },
  keys: readonly string[] = RUNTIME_SETTING_KEYS,
) {
  await Promise.all(keys.map((key) => cache.delete(`setting:${key}`)))
}
