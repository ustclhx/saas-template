import { featureModels, type ResolvedFeatureModel, resolveFeatureModel } from '@saas/ai'
import { aiModel, type Database, dbSettingStore, getSettingValue } from '@saas/db'
import { AppError } from '@saas/shared'
import { asc } from 'drizzle-orm'
import { z } from 'zod'

// 后台运行时设置的「功能模型」分组（openspec add-admin-mcp 决策 7、任务 5.2）。
// 登记表来自项目的 feature-models.project.ts；为空时返回空数组，页面不显示分组。

export const featureModelSettingKey = (feature: string) => `ai.model.${feature}`

export interface AdminFeatureModelOption {
  readonly key: string
  readonly provider: string
  readonly providerModelId: string
}

export interface AdminFeatureModel {
  readonly feature: string
  readonly kind: 'text' | 'image' | 'video'
  readonly inherit: readonly string[]
  /** 已保存的模型键，空字符串表示未选择 */
  readonly selected: string
  /** 已保存的模型不存在、已停用或种类不符 */
  readonly selectedUnavailable: boolean
  readonly resolved: ResolvedFeatureModel
  /** 同种类、已启用的模型 */
  readonly options: readonly AdminFeatureModelOption[]
}

export async function readAdminFeatureModels(db: Database): Promise<AdminFeatureModel[]> {
  const features = Object.entries(featureModels)
  if (features.length === 0) return []
  // 与运行时设置表单一样直接读事实来源，保存后立即看到新值
  const settingsCtx = { store: dbSettingStore(db) }
  const models = await db
    .select({
      key: aiModel.key,
      kind: aiModel.kind,
      provider: aiModel.provider,
      providerModelId: aiModel.providerModelId,
      enabled: aiModel.enabled,
    })
    .from(aiModel)
    .orderBy(asc(aiModel.sort), asc(aiModel.key))
  return Promise.all(
    features.map(async ([feature, { kind, inherit = [] }]) => {
      const value = await getSettingValue(settingsCtx, featureModelSettingKey(feature))
      const selected = typeof value === 'string' ? value : ''
      const options = models
        .filter((model) => model.enabled && model.kind === kind)
        .map(({ key, provider, providerModelId }) => ({ key, provider, providerModelId }))
      return {
        feature,
        kind,
        inherit,
        selected,
        selectedUnavailable: selected !== '' && !options.some((model) => model.key === selected),
        resolved: await resolveFeatureModel(db, settingsCtx, feature),
        options,
      }
    }),
  )
}

export const featureModelsInput = z.object({
  values: z.record(z.string().min(1).max(200), z.string().max(200)),
})

/**
 * 只返回有变化的功能设置键；全部未变化时返回空数组，不开启写事务。
 * 模型是否存在、种类是否一致由 writeRuntimeSetting 在写事务内检查（与 MCP settings.set 同一路径）。
 * 允许保留已停用的原选择（解析时按沿用顺序回退），避免因其中一项停用而无法保存其他功能。
 */
export async function changedFeatureModelEntries(
  db: Database,
  values: Readonly<Record<string, string>>,
) {
  const settingsCtx = { store: dbSettingStore(db) }
  const entries: (readonly [string, string])[] = []
  for (const [feature, modelKey] of Object.entries(values)) {
    if (!Object.hasOwn(featureModels, feature))
      throw new AppError('UNKNOWN_FEATURE_MODEL', `Unknown feature: ${feature}`)
    const key = featureModelSettingKey(feature)
    const current = await getSettingValue(settingsCtx, key)
    if (current !== modelKey) entries.push([key, modelKey])
  }
  return entries
}
