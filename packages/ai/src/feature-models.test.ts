import { type AiModel, type Database, getSettingDefinition } from '@saas/db'
import { expect, it, vi } from 'vitest'
import { defineFeatureModels } from './feature-model-definition.ts'
import { resolveFeatureModel } from './feature-models.ts'
import { dbModelStore } from './models.ts'

vi.mock('./feature-models.project.ts', () => ({
  default: {
    primary: { kind: 'text', inherit: ['secondary', 'tertiary'] },
    secondary: { kind: 'text', inherit: ['tertiary'] },
    tertiary: { kind: 'text' },
    adjacent: { kind: 'text', inherit: ['secondary'] },
  },
}))
vi.mock('./models.ts', () => ({ dbModelStore: vi.fn() }))

it('登记时拒绝未知功能、跨种类以及直接和间接沿用环', () => {
  expect(() => defineFeatureModels({ a: { kind: 'text', inherit: ['missing'] } })).toThrow(
    'Unknown feature model',
  )
  expect(() =>
    defineFeatureModels({ a: { kind: 'text', inherit: ['b'] }, b: { kind: 'image' } }),
  ).toThrow('Feature model kind mismatch')
  expect(() => defineFeatureModels({ a: { kind: 'text', inherit: ['a'] } })).toThrow(
    'Feature model inheritance cycle',
  )
  expect(() =>
    defineFeatureModels({
      a: { kind: 'text', inherit: ['b'] },
      b: { kind: 'text', inherit: ['a'] },
    }),
  ).toThrow('Feature model inheritance cycle')
})

it('解析显式和顺序沿用，跳过停用、异种和不存在的模型，且不递归沿用', async () => {
  function model(key: string, kind: AiModel['kind'] = 'text'): AiModel {
    return {
      id: key,
      key,
      displayName: null,
      kind,
      provider: 'test',
      providerModelId: key,
      pricing: { mode: 'per_call' },
      enabled: true,
      minPlanFeatures: [],
      paramsSchema: null,
      supportsTools: false,
      sort: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }
  }
  const selected = model('selected')
  const second = model('second')
  const third = model('third')
  const rows = [selected, second, third, model('other-kind', 'image')]
  vi.mocked(dbModelStore).mockReturnValue({
    listEnabled: async () => rows.filter(({ enabled }) => enabled),
    findEnabled: async () => undefined,
  })
  const values: Record<string, string> = { 'ai.model.tertiary': 'third' }
  const settingsCtx = { store: { find: async (key: string) => values[key] } }
  const db = {} as Database

  expect(getSettingDefinition('ai.model.primary')).toMatchObject({ default: '', secret: false })
  await expect(resolveFeatureModel(db, settingsCtx, 'primary')).resolves.toEqual({
    modelKey: 'third',
    source: 'inherited',
    from: 'tertiary',
  })
  await expect(resolveFeatureModel(db, settingsCtx, 'adjacent')).resolves.toEqual({
    modelKey: null,
    source: 'unset',
  })

  values['ai.model.primary'] = 'selected'
  values['ai.model.secondary'] = 'second'
  await expect(resolveFeatureModel(db, settingsCtx, 'primary')).resolves.toEqual({
    modelKey: 'selected',
    source: 'explicit',
  })
  selected.enabled = false
  await expect(resolveFeatureModel(db, settingsCtx, 'primary')).resolves.toEqual({
    modelKey: 'second',
    source: 'inherited',
    from: 'secondary',
  })
  values['ai.model.secondary'] = 'other-kind'
  values['ai.model.tertiary'] = 'missing'
  await expect(resolveFeatureModel(db, settingsCtx, 'primary')).resolves.toEqual({
    modelKey: null,
    source: 'unset',
  })
})
