import { featureModels, resolveFeatureModel } from '@saas/ai'
import {
  type Database,
  dbSettingStore,
  getSettingDefinition,
  listSettingDefinitions,
  setting,
  validateSettingValue,
} from '@saas/db'
import type { AdminTransaction } from '@web/features/admin/action.ts'
import {
  ConfirmationFailedError,
  fingerprint,
  STALE_TARGET,
} from '@web/features/admin/confirmations/service.ts'
import {
  invalidateRuntimeSettings,
  readRuntimeSetting,
  writeRuntimeSetting,
} from '@web/features/admin/settings.ts'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { defineAdminTool, dryRunDescription, toolResult } from './define.ts'

const keyInput = z.string().min(1)

async function getSetting(db: Database, key: string) {
  const { definition, value, source } = await readRuntimeSetting(db, key)
  const { description, secret } = definition
  // source 为 fallback 时表中的值不符合当前定义，读取方正在使用默认值；只报来源，不回显密钥
  const metadata = { key, description, secret, source }
  if (secret) return { ...metadata, isSet: value != null && value !== '' }

  const feature = key.startsWith('ai.model.') ? key.slice('ai.model.'.length) : ''
  const resolution = Object.hasOwn(featureModels, feature)
    ? await resolveFeatureModel(db, { store: dbSettingStore(db) }, feature)
    : undefined
  return {
    ...metadata,
    jsonSchema: definition.jsonSchema,
    value,
    defaultValue: definition.default,
    resolution,
  }
}

const settingsList = defineAdminTool({
  name: 'settings.list',
  scope: 'admin:read',
  description: 'List runtime settings with their input schemas, values, and secret status.',
  input: z.object({}),
  params: {},
  async run({ db }) {
    const settings = await Promise.all(
      listSettingDefinitions().map(({ key }) => getSetting(db, key)),
    )
    return toolResult({ settings })
  },
})

const settingsGet = defineAdminTool({
  name: 'settings.get',
  scope: 'admin:read',
  description:
    'Read a runtime setting and its source (database, default, or fallback when the stored value no longer matches the schema and the default is used), or check whether a secret is set.',
  input: z.object({ key: keyInput }),
  params: { key: 'Registered runtime setting key from settings.list.' },
  async run({ db }, { key }) {
    return toolResult(await getSetting(db, key))
  },
})

/** 写入前的现值（未存值时为默认值），与 writeRuntimeSetting 的读取方式一致 */
async function storedSettingValue(tx: AdminTransaction, key: string) {
  const [row] = await tx
    .select({ value: sql<unknown>`${setting.value}` })
    .from(setting)
    .where(eq(setting.key, key))
  return row === undefined ? getSettingDefinition(key)?.default : row.value
}

const isSet = (value: unknown) => value != null && value !== ''

/** 确认页只显示密钥的末 4 位，且只在值足够长时显示 */
function lastFour(value: unknown) {
  return typeof value === 'string' && value.length >= 12 ? value.slice(-4) : undefined
}

const secretSettingPayload = z.object({ key: z.string(), current: z.string() })

const settingsSet = defineAdminTool({
  name: 'settings.set',
  scope: 'admin:write',
  description: 'Preview or save a registered runtime setting.',
  input: z.strictObject({ key: keyInput, value: z.unknown(), dryRun: z.boolean().optional() }),
  params: {
    key: 'Registered runtime setting key from settings.list.',
    value: 'New JSON value matching the input schema for this setting.',
    dryRun: dryRunDescription,
  },
  adminAction: ({ key, value }) => ({ name: 'setting.update', input: { entries: [[key, value]] } }),
  async run(ctx, { key, value }) {
    const changes = await writeRuntimeSetting(ctx, key, value, ctx.dryRun)
    ctx.afterCommit(() => invalidateRuntimeSettings(ctx.cache, [key]))
    return toolResult({ key, ...changes, dryRun: ctx.dryRun })
  },
  // 只有改动密钥类设置时才走确认（setting.update 的判定），值加密保存，不进 payload / display
  async confirm(ctx, { key, value }) {
    const { definition } = await readRuntimeSetting(ctx.db, key)
    await writeRuntimeSetting(ctx, key, value, true)
    const next = validateSettingValue(key, value)
    const current = await storedSettingValue(ctx.tx, key)
    const suffix = lastFour(next)
    return {
      summary: `Update secret setting ${key}`,
      display: {
        kind: 'setting',
        key,
        description: definition.description,
        secret: true,
        before: { isSet: isSet(current) },
        after: { isSet: isSet(next), ...(suffix && { last4: suffix }) },
      },
      payload: { key, current: await fingerprint(current) },
      secret: next,
    }
  },
  execute: (env) => ({
    kind: 'transaction',
    async run(scope, { record, secret }) {
      const { key, current } = secretSettingPayload.parse(record.payload)
      // 与 writeRuntimeSetting 同一把锁：比对快照与写入之间不会插入其他保存
      await scope.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`setting:${key}`}, 0))`,
      )
      if ((await fingerprint(await storedSettingValue(scope.tx, key))) !== current)
        throw new ConfirmationFailedError(STALE_TARGET, 'The setting changed after the request')
      const changes = await writeRuntimeSetting(scope, key, secret)
      return { key, ...changes }
    },
    afterCommit: ({ record }) =>
      invalidateRuntimeSettings(env.cache, [secretSettingPayload.parse(record.payload).key]),
  }),
})

const featureModelsList = defineAdminTool({
  name: 'features.models',
  scope: 'admin:read',
  description:
    'List feature model selections and show whether each is explicit, inherited, or unset.',
  input: z.object({}),
  params: {},
  async run({ db }) {
    const store = dbSettingStore(db)
    const features = await Promise.all(
      Object.entries(featureModels).map(async ([feature, { kind, inherit }]) => ({
        feature,
        kind,
        inherit: inherit ?? [],
        resolution: await resolveFeatureModel(db, { store }, feature),
      })),
    )
    return toolResult({ features })
  },
})

export const settingTools = [settingsList, settingsGet, settingsSet, featureModelsList]
