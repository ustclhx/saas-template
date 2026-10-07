import type { AiModel } from '@saas/db'
import { DEFAULT_FREE_FEATURES, type Entitlements, UPGRADE_REQUIRED } from '@saas/entitlements'
import { AppError } from '@saas/shared'
import { describe, expect, it } from 'vitest'
import {
  defaultPricing,
  invalidateModelCache,
  listAvailableModels,
  MODEL_CACHE_KEY,
  MODEL_CACHE_TTL_SECONDS,
  MODEL_UNAVAILABLE,
  type ModelCache,
  type ModelStore,
  modelValues,
  requireAvailableModel,
} from './models.ts'
import { PricingError } from './pricing.ts'

function row(overrides: Partial<AiModel> & Pick<AiModel, 'id' | 'key'>): AiModel {
  return {
    kind: 'text',
    provider: 'openai',
    providerModelId: overrides.key,
    pricing: { mode: 'token', inputPer1k: 2, outputPer1k: 8 },
    minPlanFeatures: [],
    paramsSchema: null,
    enabled: true,
    sort: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

/** 模拟 ai_model 表：只返回 enabled 的行，与 dbModelStore 的查询条件一致 */
function memoryStore(rows: AiModel[]) {
  let listCalls = 0
  const store: ModelStore = {
    async listEnabled() {
      listCalls++
      return rows.filter((r) => r.enabled).sort((a, b) => a.sort - b.sort)
    },
    async findEnabled(id) {
      return rows.find((r) => r.id === id && r.enabled)
    },
  }
  return { store, rows, listCalls: () => listCalls }
}

function memoryCache() {
  const data = new Map<string, string>()
  const ttls: (number | undefined)[] = []
  const cache: ModelCache = {
    async get(key) {
      return data.get(key) ?? null
    },
    async put(key, value, options) {
      data.set(key, value)
      ttls.push(options?.expirationTtl)
    },
    async delete(key) {
      data.delete(key)
    },
  }
  return { cache, data, ttls }
}

const plan = (models: string[]): Entitlements => ({
  key: 'pro',
  sort: 1,
  features: { ...DEFAULT_FREE_FEATURES, models },
})
const all = plan(['*'])

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  return error as AppError
}

describe('listAvailableModels', () => {
  it('停用模型不出现在列表中', async () => {
    const { store } = memoryStore([
      row({ id: 'm1', key: 'gpt-a' }),
      row({ id: 'm2', key: 'gpt-b', enabled: false }),
    ])
    const models = await listAvailableModels({ store }, all)
    expect(models.map((m) => m.key)).toEqual(['gpt-a'])
  })

  it('按空间权益过滤：模型 key 或标签匹配 plan.features.models', async () => {
    const { store } = memoryStore([
      row({ id: 'm1', key: 'gpt-a', sort: 1 }),
      row({ id: 'm2', key: 'claude-b', minPlanFeatures: ['premium'], sort: 2 }),
      row({ id: 'm3', key: 'flux', kind: 'image', sort: 3 }),
    ])
    expect((await listAvailableModels({ store }, plan(['gpt-a']))).map((m) => m.key)).toEqual([
      'gpt-a',
    ])
    expect((await listAvailableModels({ store }, plan(['premium']))).map((m) => m.key)).toEqual([
      'claude-b',
    ])
    expect(await listAvailableModels({ store }, plan([]))).toEqual([])
    expect(
      (await listAvailableModels({ store }, all, { kind: 'image' })).map((m) => m.key),
    ).toEqual(['flux'])
  })

  it('计费方式不合法的模型不出现在列表中', async () => {
    const { store } = memoryStore([
      row({ id: 'm1', key: 'gpt-a', pricing: { mode: 'per_call', credits: 1 } }),
    ])
    expect(await listAvailableModels({ store }, all)).toEqual([])
  })

  it('命中缓存时不再查库，失效后重新读取', async () => {
    const { store, rows, listCalls } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const { cache, data, ttls } = memoryCache()
    const ctx = { store, cache }

    expect((await listAvailableModels(ctx, all)).map((m) => m.key)).toEqual(['gpt-a'])
    expect(listCalls()).toBe(1)
    expect(data.has(MODEL_CACHE_KEY)).toBe(true)
    expect(ttls).toEqual([MODEL_CACHE_TTL_SECONDS])

    // 后台停用后、失效前：仍返回缓存内容，不查库
    rows[0] = row({ id: 'm1', key: 'gpt-a', enabled: false })
    expect((await listAvailableModels(ctx, all)).map((m) => m.key)).toEqual(['gpt-a'])
    expect(listCalls()).toBe(1)

    await invalidateModelCache(cache)
    expect(await listAvailableModels(ctx, all)).toEqual([])
    expect(listCalls()).toBe(2)
  })

  it('权益过滤在缓存之后进行，不同空间共享同一份缓存', async () => {
    const { store, listCalls } = memoryStore([
      row({ id: 'm1', key: 'gpt-a' }),
      row({ id: 'm2', key: 'gpt-b' }),
    ])
    const { cache } = memoryCache()
    expect(await listAvailableModels({ store, cache }, plan(['gpt-a']))).toHaveLength(1)
    expect(await listAvailableModels({ store, cache }, all)).toHaveLength(2)
    expect(listCalls()).toBe(1)
  })
})

describe('requireAvailableModel', () => {
  it('返回已启用且有权限的模型及其定价快照', async () => {
    const { store } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const model = await requireAvailableModel({ store }, all, 'm1')
    expect(model.key).toBe('gpt-a')
    expect(model.pricing).toEqual({ mode: 'token', inputPer1k: 2, outputPer1k: 8 })
  })

  it('停用模型被拒绝，即使列表缓存中仍有该模型', async () => {
    const { store, rows } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const { cache } = memoryCache()
    await listAvailableModels({ store, cache }, all)
    rows[0] = row({ id: 'm1', key: 'gpt-a', enabled: false })

    const error = await rejection(requireAvailableModel({ store }, all, 'm1'))
    expect(error.code).toBe(MODEL_UNAVAILABLE)
    expect(error.status).toBe(404)
  })

  it('不存在的模型与停用模型返回同样的错误', async () => {
    const { store } = memoryStore([])
    expect((await rejection(requireAvailableModel({ store }, all, 'missing'))).code).toBe(
      MODEL_UNAVAILABLE,
    )
  })

  it('权益不允许的模型被拒绝', async () => {
    const { store } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const error = await rejection(requireAvailableModel({ store }, plan(['other']), 'm1'))
    expect(error.code).toBe(UPGRADE_REQUIRED)
    expect(error.status).toBe(403)
  })
})

describe('defaultPricing', () => {
  it('按模板配置的 ai.defaultPricingMode 预填计费方式', () => {
    const modes = { text: 'token', image: 'per_call', video: 'per_unit' } as const
    expect(defaultPricing('text', modes).mode).toBe('token')
    expect(defaultPricing('image', modes).mode).toBe('per_call')
    expect(defaultPricing('video', modes)).toMatchObject({ mode: 'per_unit', unit: 'second' })
    expect(defaultPricing('text', { ...modes, text: 'per_call' })).toMatchObject({
      mode: 'per_call',
      chargeOn: 'any_output',
    })
  })
})

describe('modelValues', () => {
  const base = {
    key: ' gpt-a ',
    kind: 'text' as const,
    provider: 'openai',
    providerModelId: 'gpt-a',
    tags: ['premium', ' premium ', ''],
    enabled: true,
    sort: 0,
  }

  it('保存缺少 token 上限的按次文本模型被拒绝', () => {
    expect(() => modelValues({ ...base, pricing: { mode: 'per_call', credits: 1 } })).toThrow(
      PricingError,
    )
  })

  it('按次文本模型带 token 上限时可以保存', () => {
    const pricing = {
      mode: 'per_call',
      credits: 1,
      limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
    }
    expect(modelValues({ ...base, pricing })).toMatchObject({
      key: 'gpt-a',
      pricing,
      minPlanFeatures: ['premium'],
    })
  })

  it('不合法的计费方式被拒绝', () => {
    expect(() => modelValues({ ...base, pricing: { mode: 'free' } })).toThrow(PricingError)
  })
})
