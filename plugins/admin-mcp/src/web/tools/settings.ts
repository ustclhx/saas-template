import { featureModels, resolveFeatureModel } from '@saas/ai'
import { type Database, dbSettingStore, listSettingDefinitions } from '@saas/db'
import {
  invalidateRuntimeSettings,
  readRuntimeSetting,
  writeRuntimeSetting,
} from '@web/features/admin/settings.ts'
import { z } from 'zod'
import { defineAdminTool, toolResult } from './define.ts'

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
  description: 'List runtime settings, their input schemas, and values or secret presence',
  input: z.object({}),
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
    'Read a runtime setting and its source (database, default, or fallback when the stored value no longer matches the schema and the default is used), or whether a secret is set',
  input: z.object({ key: keyInput }),
  async run({ db }, { key }) {
    return toolResult(await getSetting(db, key))
  },
})

const settingsSet = defineAdminTool({
  name: 'settings.set',
  scope: 'admin:write',
  description: 'Preview or save a registered runtime setting',
  input: z.strictObject({ key: keyInput, value: z.unknown(), dryRun: z.boolean().optional() }),
  async run(ctx, { key, value }) {
    const changes = await writeRuntimeSetting(ctx, key, value, ctx.dryRun)
    return toolResult({ key, ...changes, dryRun: ctx.dryRun })
  },
  afterCommit: ({ cache }, { key }) => invalidateRuntimeSettings(cache, [key]),
})

const featureModelsList = defineAdminTool({
  name: 'features.models',
  scope: 'admin:read',
  description: 'List feature model selections and their explicit, inherited, or unset resolution',
  input: z.object({}),
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
