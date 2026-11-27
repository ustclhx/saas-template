import type { AiModel } from '@saas/db'
import { DEFAULT_FREE_FEATURES, type Entitlements, UPGRADE_REQUIRED } from '@saas/entitlements'
import { AppError } from '@saas/shared'
import { describe, expect, it } from 'vitest'
import type { ModelFallback } from './failover/fallbacks.ts'
import {
  assertModelFallbacks,
  type FallbackModelRef,
  listAvailableModels,
  MODEL_FALLBACK_INVALID,
  MODEL_UNAVAILABLE,
  type ModelStore,
  mapFallbackParams,
  parseModelFallbacks,
  requireAvailableModel,
  resolveModelCandidates,
} from './models.ts'

// specs/ai-model-registry「备用模型配置」「备用模型不影响用户可见性与价格」

function mediaSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = ['prompt'],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: { prompt: { type: 'string', maxLength: 2000 }, ...properties },
    required,
  }
}

const seedreamFal: FallbackModelRef = {
  key: 'seedream-fal',
  kind: 'image',
  provider: 'fal',
  supportsTools: false,
  paramsSchema: mediaSchema({
    aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
    num_images: { type: 'integer', minimum: 1, maximum: 4 },
  }),
}

const seedreamReplicate: FallbackModelRef = {
  key: 'seedream-replicate',
  kind: 'image',
  provider: 'replicate',
  supportsTools: false,
  paramsSchema: mediaSchema({
    aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3'] },
    num_images: { type: 'integer', minimum: 1, maximum: 4 },
  }),
}

function models(...refs: FallbackModelRef[]) {
  return new Map(refs.map((ref) => [ref.key, ref]))
}

function expectFallbackError(run: () => unknown, message: RegExp, field?: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(MODEL_FALLBACK_INVALID)
    expect((error as AppError).status).toBe(400)
    expect((error as AppError).message).toMatch(message)
    if (field) expect((error as AppError).publicDetails).toMatchObject({ field })
    return
  }
  throw new Error('expected MODEL_FALLBACK_INVALID')
}

describe('备用模型配置校验', () => {
  it('配置跨服务商备用：参数完全兼容时通过，并保留顺序', () => {
    const kie: FallbackModelRef = { ...seedreamReplicate, key: 'seedream-kie', provider: 'kie' }
    const fallbacks = parseModelFallbacks([
      { modelKey: 'seedream-replicate' },
      { modelKey: 'seedream-kie', paramMap: {} },
    ])
    expect(fallbacks).toEqual([{ modelKey: 'seedream-replicate' }, { modelKey: 'seedream-kie' }])
    expect(() =>
      assertModelFallbacks(seedreamFal, fallbacks, models(seedreamReplicate, kie)),
    ).not.toThrow()
  })

  it('参数不兼容：主模型允许 21:9 而备用不允许时拒绝并指出 aspect_ratio', () => {
    const primary = {
      ...seedreamFal,
      paramsSchema: mediaSchema({
        aspect_ratio: { type: 'string', enum: ['1:1', '21:9'] },
      }),
    }
    expectFallbackError(
      () =>
        assertModelFallbacks(
          primary,
          [{ modelKey: 'seedream-replicate' }],
          models(seedreamReplicate),
        ),
      /aspect_ratio.*21:9/,
      'aspect_ratio',
    )
  })

  it('参数改名：image_size → size 映射后校验通过；缺映射时拒绝', () => {
    const primary = {
      ...seedreamFal,
      paramsSchema: mediaSchema({ image_size: { type: 'string', enum: ['square', 'portrait'] } }),
    }
    const fallback = {
      ...seedreamReplicate,
      paramsSchema: mediaSchema({ size: { type: 'string', enum: ['square', 'portrait', 'wide'] } }),
    }
    expect(() =>
      assertModelFallbacks(
        primary,
        parseModelFallbacks([{ modelKey: fallback.key, paramMap: { image_size: 'size' } }]),
        models(fallback),
      ),
    ).not.toThrow()
    expectFallbackError(
      () => assertModelFallbacks(primary, [{ modelKey: fallback.key }], models(fallback)),
      /image_size.*no parameter image_size/,
      'image_size',
    )
    expect(
      mapFallbackParams({ image_size: 'square', prompt: 'x' }, { image_size: 'size' }),
    ).toEqual({ size: 'square', prompt: 'x' })
  })

  it('文本备用缺少工具能力时拒绝', () => {
    const primary: FallbackModelRef = {
      key: 'gpt',
      kind: 'text',
      provider: 'openai',
      supportsTools: true,
      paramsSchema: null,
    }
    const noTools = { ...primary, key: 'deepseek', provider: 'deepseek', supportsTools: false }
    expectFallbackError(
      () => assertModelFallbacks(primary, [{ modelKey: 'deepseek' }], models(noTools)),
      /does not support tool calls/,
      'supportsTools',
    )
    const withTools = { ...noTools, supportsTools: true }
    expect(() =>
      assertModelFallbacks(primary, [{ modelKey: 'deepseek' }], models(withTools)),
    ).not.toThrow()
    // 主模型不需要工具时，备用不要求工具能力
    expect(() =>
      assertModelFallbacks(
        { ...primary, supportsTools: false },
        [{ modelKey: 'deepseek' }],
        models(noTools),
      ),
    ).not.toThrow()
  })

  it('备用链不成环：自身或同服务商的模型被拒绝', () => {
    expectFallbackError(
      () => assertModelFallbacks(seedreamFal, [{ modelKey: seedreamFal.key }], models(seedreamFal)),
      /own fallback/,
    )
    const sameProvider = { ...seedreamReplicate, key: 'seedream-fal-2', provider: 'fal' }
    expectFallbackError(
      () =>
        assertModelFallbacks(seedreamFal, [{ modelKey: sameProvider.key }], models(sameProvider)),
      /different provider/,
    )
    // 两个备用彼此也必须不同服务商
    const another = { ...seedreamReplicate, key: 'seedream-replicate-2' }
    expectFallbackError(
      () =>
        assertModelFallbacks(
          seedreamFal,
          [{ modelKey: seedreamReplicate.key }, { modelKey: another.key }],
          models(seedreamReplicate, another),
        ),
      /different provider/,
    )
  })

  it('数量、存在性与类型', () => {
    expectFallbackError(
      () => parseModelFallbacks([{ modelKey: 'a' }, { modelKey: 'b' }, { modelKey: 'c' }]),
      /At most 2/,
    )
    expectFallbackError(() => parseModelFallbacks([{ key: 'a' }]), /modelKey/)
    expectFallbackError(
      () => assertModelFallbacks(seedreamFal, [{ modelKey: 'missing' }], models()),
      /does not exist/,
    )
    const video = { ...seedreamReplicate, kind: 'video' as const }
    expectFallbackError(
      () => assertModelFallbacks(seedreamFal, [{ modelKey: video.key }], models(video)),
      /must be a image model/,
    )
    expect(parseModelFallbacks(undefined)).toEqual([])
  })

  it('数值范围、类型与必填字段按备用覆盖主模型校验', () => {
    const narrow = {
      ...seedreamReplicate,
      paramsSchema: mediaSchema({
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
        num_images: { type: 'integer', minimum: 1, maximum: 2 },
      }),
    }
    expectFallbackError(
      () => assertModelFallbacks(seedreamFal, [{ modelKey: narrow.key }], models(narrow)),
      /num_images.*range/,
      'num_images',
    )
    const wrongType = {
      ...seedreamReplicate,
      paramsSchema: mediaSchema({
        aspect_ratio: { type: 'number' },
        num_images: { type: 'integer', minimum: 1, maximum: 4 },
      }),
    }
    expectFallbackError(
      () => assertModelFallbacks(seedreamFal, [{ modelKey: wrongType.key }], models(wrongType)),
      /aspect_ratio.*type string/,
      'aspect_ratio',
    )
    const shortPrompt = {
      ...seedreamReplicate,
      paramsSchema: {
        ...mediaSchema({
          aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
          num_images: { type: 'integer', minimum: 1, maximum: 4 },
        }),
        properties: {
          prompt: { type: 'string', maxLength: 500 },
          aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
          num_images: { type: 'integer', minimum: 1, maximum: 4 },
        },
      },
    }
    expectFallbackError(
      () => assertModelFallbacks(seedreamFal, [{ modelKey: shortPrompt.key }], models(shortPrompt)),
      /prompt.*maxLength/,
      'prompt',
    )
    const requiresSeed = {
      ...seedreamReplicate,
      paramsSchema: mediaSchema(
        {
          aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
          num_images: { type: 'integer', minimum: 1, maximum: 4 },
          seed: { type: 'integer' },
        },
        ['prompt', 'seed'],
      ),
    }
    expectFallbackError(
      () =>
        assertModelFallbacks(seedreamFal, [{ modelKey: requiresSeed.key }], models(requiresSeed)),
      /requires seed/,
    )
  })

  it('paramMap 只能引用主模型字段，且映射目标不能重复；文本模型不接受 paramMap', () => {
    expectFallbackError(
      () =>
        assertModelFallbacks(
          seedreamFal,
          [{ modelKey: seedreamReplicate.key, paramMap: { unknown: 'x' } }],
          models(seedreamReplicate),
        ),
      /unknown.*not a parameter/,
    )
    expectFallbackError(
      () =>
        assertModelFallbacks(
          seedreamFal,
          [{ modelKey: seedreamReplicate.key, paramMap: { aspect_ratio: 'prompt' } }],
          models(seedreamReplicate),
        ),
      /maps to prompt/,
    )
    const text: FallbackModelRef = {
      key: 'a',
      kind: 'text',
      provider: 'openai',
      supportsTools: false,
      paramsSchema: null,
    }
    expectFallbackError(
      () =>
        assertModelFallbacks(
          text,
          [{ modelKey: 'b', paramMap: { x: 'y' } }],
          models({ ...text, key: 'b', provider: 'deepseek' }),
        ),
      /only supported for media/,
    )
  })
})

// ---------------------------------------------------------------------------

function row(overrides: Partial<AiModel> & Pick<AiModel, 'id' | 'key'>): AiModel {
  return {
    kind: 'image',
    displayName: null,
    provider: 'fal',
    providerModelId: overrides.key,
    pricing: { mode: 'per_unit', unit: 'image', perUnit: 10 },
    minPlanFeatures: [],
    paramsSchema: null,
    enabled: true,
    supportsTools: false,
    fallbacks: [],
    sort: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

function memoryStore(rows: AiModel[]): ModelStore {
  return {
    async listEnabled() {
      return rows.filter((r) => r.enabled)
    },
    async findEnabled(id) {
      return rows.find((r) => r.id === id && r.enabled)
    },
    async findByKeys(keys) {
      return rows.filter((r) => keys.includes(r.key))
    },
  }
}

const plan = (models: string[]): Entitlements => ({
  key: 'basic',
  sort: 1,
  features: { ...DEFAULT_FREE_FEATURES, models },
})

describe('备用模型不影响用户可见性与价格', () => {
  const fallbacks: ModelFallback[] = [
    { modelKey: 'backup-disabled', paramMap: { image_size: 'size' } },
    { modelKey: 'backup-hidden' },
  ]
  const rows = [
    row({ id: 'p', key: 'primary', fallbacks, minPlanFeatures: ['basic'] }),
    row({
      id: 'd',
      key: 'backup-disabled',
      provider: 'replicate',
      enabled: false,
      pricing: { mode: 'per_unit', unit: 'image', perUnit: 99 },
    }),
    row({ id: 'h', key: 'backup-hidden', provider: 'kie', minPlanFeatures: ['pro-only'] }),
  ]
  const ctx = { store: memoryStore(rows) }
  const entitlements = plan(['basic'])

  it('备用模型对用户隐藏：停用或不在套餐中的备用不出现在模型选择器', async () => {
    const listed = await listAvailableModels(ctx, entitlements, { kind: 'image' })
    expect(listed.map((model) => model.key)).toEqual(['primary'])
    // 读取主模型带出有序备用链
    expect(listed[0]?.fallbacks).toEqual(fallbacks)
  })

  it('权益判断只看主模型：直接请求备用模型被拒绝', async () => {
    await expect(requireAvailableModel(ctx, entitlements, 'd')).rejects.toMatchObject({
      code: MODEL_UNAVAILABLE,
    })
    await expect(requireAvailableModel(ctx, entitlements, 'h')).rejects.toMatchObject({
      code: UPGRADE_REQUIRED,
    })
  })

  it('主模型切换时仍可使用停用 / 不可见的备用，计费仍取主模型定价', async () => {
    const primary = await requireAvailableModel(ctx, entitlements, 'p')
    expect(primary.pricing).toEqual({ mode: 'per_unit', unit: 'image', perUnit: 10 })
    const candidates = await resolveModelCandidates(ctx, primary)
    expect(candidates.map((model) => [model.key, model.provider])).toEqual([
      ['primary', 'fal'],
      ['backup-disabled', 'replicate'],
      ['backup-hidden', 'kie'],
    ])
    expect(candidates[1]?.paramMap).toEqual({ image_size: 'size' })
    expect(candidates[0]?.pricing).toBe(primary.pricing)
  })

  it('已删除或类型不符的备用被跳过；无备用时只返回主模型', async () => {
    const store = memoryStore([
      row({
        id: 'p',
        key: 'primary',
        fallbacks: [{ modelKey: 'gone' }, { modelKey: 'text-model' }],
      }),
      row({ id: 't', key: 'text-model', kind: 'text', provider: 'openai' }),
    ])
    const primary = await requireAvailableModel({ store }, plan(['*']), 'p')
    expect((await resolveModelCandidates({ store }, primary)).map(({ key }) => key)).toEqual([
      'primary',
    ])
    const lone = { ...primary, fallbacks: [] }
    expect(await resolveModelCandidates({ store }, lone)).toEqual([lone])
  })

  it('agent（requiresTools）跳过保存后被关掉工具标记的备用，顺序不变', async () => {
    const store = memoryStore([
      row({
        id: 'p',
        key: 'agent-primary',
        kind: 'text',
        provider: 'openai',
        supportsTools: true,
        fallbacks: [{ modelKey: 'no-tools' }, { modelKey: 'with-tools' }],
      }),
      row({ id: 'n', key: 'no-tools', kind: 'text', provider: 'anthropic', supportsTools: false }),
      row({ id: 'w', key: 'with-tools', kind: 'text', provider: 'google', supportsTools: true }),
    ])
    const primary = await requireAvailableModel({ store }, plan(['*']), 'p', {
      requiresTools: true,
    })
    const keys = async (options?: { requiresTools?: boolean }) =>
      (await resolveModelCandidates({ store }, primary, options)).map(({ key }) => key)
    expect(await keys({ requiresTools: true })).toEqual(['agent-primary', 'with-tools'])
    // 对话不要求工具：两个备用都保留
    expect(await keys()).toEqual(['agent-primary', 'no-tools', 'with-tools'])
  })
})

describe('计量字段', () => {
  it('备用 schema 有计量字段而主模型没有时拒绝：备用可能按自身默认值多生成', () => {
    const primary: FallbackModelRef = {
      ...seedreamFal,
      key: 'single-image-fal',
      paramsSchema: mediaSchema({ aspect_ratio: { type: 'string', enum: ['1:1'] } }),
    }
    expectFallbackError(
      () =>
        assertModelFallbacks(
          primary,
          [{ modelKey: seedreamReplicate.key }],
          models(seedreamReplicate),
        ),
      /units parameter must map to num_images/,
    )
    // 计量字段改名到其他字段同样拒绝。
    expectFallbackError(
      () =>
        assertModelFallbacks(
          seedreamFal,
          [{ modelKey: seedreamReplicate.key, paramMap: { num_images: 'count' } }],
          models({
            ...seedreamReplicate,
            paramsSchema: mediaSchema({
              aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
              count: { type: 'integer', minimum: 1, maximum: 4 },
              num_images: { type: 'integer', minimum: 1, maximum: 4 },
            }),
          }),
        ),
      /units parameter must map to num_images/,
    )
  })
})
