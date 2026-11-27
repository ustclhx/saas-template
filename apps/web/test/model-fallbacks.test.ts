import { deleteModelByKey, MODEL_FALLBACK_INVALID, validateModelFallbacks } from '@saas/ai'
import { aiModel, type NewAiModel } from '@saas/db'
import { newId } from '@saas/shared'
import { inArray } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createAdminTestDb } from './admin-test-resources.ts'

// specs/ai-model-registry「删除被引用的备用模型」：删除与移除引用在同一事务内完成。
it('保存校验读取被引用模型；删除被引用的备用模型时从所有备用链中移除', async () => {
  const db = createAdminTestDb()
  const suffix = newId()
  const keys = {
    primary: `fb-primary-${suffix}`,
    other: `fb-other-${suffix}`,
    replicate: `fb-replicate-${suffix}`,
    kie: `fb-kie-${suffix}`,
  }
  const schema = {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  }
  const model = (key: string, provider: string, extra: Partial<NewAiModel> = {}): NewAiModel => ({
    key,
    kind: 'image',
    provider,
    providerModelId: key,
    pricing: { mode: 'per_unit', unit: 'image', perUnit: 1 },
    paramsSchema: schema,
    ...extra,
  })
  try {
    await db
      .insert(aiModel)
      .values([model(keys.replicate, 'replicate', { enabled: false }), model(keys.kie, 'kie')])
    const primaryRef = {
      key: keys.primary,
      kind: 'image' as const,
      provider: 'fal',
      supportsTools: false,
      paramsSchema: schema,
    }
    const fallbacks = await validateModelFallbacks(db, primaryRef, [
      { modelKey: keys.replicate },
      { modelKey: keys.kie },
    ])
    await expect(
      validateModelFallbacks(db, primaryRef, [{ modelKey: `missing-${suffix}` }]),
    ).rejects.toMatchObject({ code: MODEL_FALLBACK_INVALID })

    await db
      .insert(aiModel)
      .values([
        model(keys.primary, 'fal', { fallbacks, sort: 7 }),
        model(keys.other, 'workers-ai', { fallbacks: [{ modelKey: keys.replicate }] }),
      ])

    const result = await deleteModelByKey(db, keys.replicate)
    expect(result.deleted).toBe(true)
    expect(result.detachedFrom.sort()).toEqual([keys.primary, keys.other].sort())

    const rows = await db
      .select({ key: aiModel.key, fallbacks: aiModel.fallbacks, sort: aiModel.sort })
      .from(aiModel)
      .where(inArray(aiModel.key, Object.values(keys)))
    const byKey = new Map(rows.map((row) => [row.key, row]))
    expect(byKey.has(keys.replicate)).toBe(false)
    // 其余备用与主模型配置不变
    expect(byKey.get(keys.primary)).toEqual({
      key: keys.primary,
      fallbacks: [{ modelKey: keys.kie }],
      sort: 7,
    })
    expect(byKey.get(keys.other)?.fallbacks).toEqual([])
    expect(byKey.get(keys.kie)?.fallbacks).toEqual([])
  } finally {
    await db.delete(aiModel).where(inArray(aiModel.key, Object.values(keys)))
  }
})
