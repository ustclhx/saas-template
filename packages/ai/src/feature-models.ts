import {
  type Database,
  defineSetting,
  getSettingValue,
  registerSettingDefinitions,
  type SettingsContext,
} from '@saas/db'
import { z } from 'zod'
import type { FeatureModelDefinitions } from './feature-model-definition.ts'
import projectFeatureModels from './feature-models.project.ts'
import { dbModelStore } from './models.ts'

export const featureModels: FeatureModelDefinitions = projectFeatureModels

const featureSettingKey = (feature: string) => `ai.model.${feature}`

export const featureModelSettings = Object.fromEntries(
  Object.keys(featureModels).map((feature) => [
    featureSettingKey(feature),
    defineSetting({
      schema: z.string(),
      default: '',
      description: `${feature} 功能使用的模型键，空字符串表示未选择`,
    }),
  ]),
)
registerSettingDefinitions(featureModelSettings)

export type ResolvedFeatureModel =
  | { modelKey: string; source: 'explicit' }
  | { modelKey: string; source: 'inherited'; from: string }
  | { modelKey: null; source: 'unset' }

/** 模型状态直接读库；执行模型调用时仍须做既有的套餐权限检查。 */
export async function resolveFeatureModel(
  db: Database,
  settingsCtx: SettingsContext,
  feature: string,
): Promise<ResolvedFeatureModel> {
  const definition = Object.hasOwn(featureModels, feature) ? featureModels[feature] : undefined
  if (!definition) throw new RangeError(`Unknown feature model: ${feature}`)

  const { kind, inherit } = definition
  const modelStore = dbModelStore(db)
  let enabledModels: Awaited<ReturnType<typeof modelStore.listEnabled>> | undefined
  async function findSelected(candidate: string) {
    const modelKey = await getSettingValue(settingsCtx, featureSettingKey(candidate))
    if (typeof modelKey !== 'string' || modelKey === '') return undefined
    enabledModels ??= await modelStore.listEnabled()
    if (enabledModels.some((model) => model.key === modelKey && model.kind === kind)) {
      return modelKey
    }
  }

  const explicit = await findSelected(feature)
  if (explicit !== undefined) return { modelKey: explicit, source: 'explicit' }
  for (const from of inherit ?? []) {
    const modelKey = await findSelected(from)
    if (modelKey !== undefined) return { modelKey, source: 'inherited', from }
  }
  return { modelKey: null, source: 'unset' }
}
