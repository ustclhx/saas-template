import { featureModels, resolveFeatureModel } from '@saas/ai'
import { type Database, dbSettingStore, listSettingDefinitions } from '@saas/db'
import {
  invalidateRuntimeSettings,
  readRuntimeSetting,
  writeRuntimeSetting,
} from '@web/features/admin/settings.ts'
import { z } from 'zod'
import { defineAdminTool, dryRunDescription, toolResult } from './define.ts'

const keyInput = z.string().min(1)

async function getSetting(db: Database, key: string) {
  const { definition, value, source } = await readRuntimeSetting(db, key)
  const { description, secret } = definition
  const metadata = { key, description, secret }
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
    source,
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
  description: 'Read a runtime setting and its source, or check whether a secret is set.',
  input: z.object({ key: keyInput }),
  params: { key: 'Registered runtime setting key from settings.list.' },
  async run({ db }, { key }) {
    return toolResult(await getSetting(db, key))
  },
})

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
    return toolResult({ key, ...changes, dryRun: ctx.dryRun })
  },
  afterCommit: ({ cache }, { key }) => invalidateRuntimeSettings(cache, [key]),
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
