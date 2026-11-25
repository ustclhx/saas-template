import { resolveFeatureModel } from '@saas/ai'
import { aiModel, dbSettingStore, type NewAiModel, setting, validateSettingValue } from '@saas/db'
import { newId } from '@saas/shared'
import { eq, inArray } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { createAdminTestDb } from './admin-test-resources.ts'

vi.mock('../../../packages/ai/src/feature-models.project.ts', () => ({
  default: {
    'mcp-test-primary': { kind: 'text', inherit: ['mcp-test-fallback'] },
    'mcp-test-fallback': { kind: 'text' },
  },
}))

it('从数据库加载显式选择，停用模型后实时沿用同类模型', async () => {
  const db = createAdminTestDb()
  const primary = 'mcp-test-primary'
  const primaryKey = `ai.model.${primary}`
  const fallbackKey = 'ai.model.mcp-test-fallback'
  const modelKey = `model-${newId()}`
  const fallbackModelKey = `model-${newId()}`
  const modelKeys = [modelKey, fallbackModelKey]
  const ctx = { store: dbSettingStore(db) }
  try {
    await db.insert(aiModel).values(
      modelKeys.map<NewAiModel>((key) => ({
        key,
        kind: 'text',
        provider: 'test',
        providerModelId: key,
        pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1 },
        enabled: true,
      })),
    )
    await expect(resolveFeatureModel(db, ctx, primary)).resolves.toEqual({
      modelKey: null,
      source: 'unset',
    })
    await db.insert(setting).values({
      key: fallbackKey,
      value: validateSettingValue(fallbackKey, fallbackModelKey),
    })
    const inherited = {
      modelKey: fallbackModelKey,
      source: 'inherited',
      from: 'mcp-test-fallback',
    }
    await expect(resolveFeatureModel(db, ctx, primary)).resolves.toEqual(inherited)

    await db
      .insert(setting)
      .values({ key: primaryKey, value: validateSettingValue(primaryKey, modelKey) })
    await expect(resolveFeatureModel(db, ctx, primary)).resolves.toEqual({
      modelKey,
      source: 'explicit',
    })
    await db.update(aiModel).set({ enabled: false }).where(eq(aiModel.key, modelKey))
    await expect(resolveFeatureModel(db, ctx, primary)).resolves.toEqual(inherited)
  } finally {
    await db.delete(setting).where(inArray(setting.key, [primaryKey, fallbackKey]))
    await db.delete(aiModel).where(inArray(aiModel.key, modelKeys))
  }
})
